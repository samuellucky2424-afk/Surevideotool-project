// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './_supabase.js';
import { logPaymentActivity } from '../shared/payment-activity-log.js';

import { sessionOrigin, sessionUser, createMorphlySession } from '../shared/morphly-session.js';
import { normalizeMorphlyModel, validateMorphlyReferenceImage, MORPHLY_EDITING_TYPE } from '../shared/morphly-models.js';

const CREDITS_PER_SECOND = 2;
const MAX_BILLABLE_SECONDS = 7200;
const SESSION_BILLING_GRACE_SECONDS = 20;
const REALTIME_START_COOLDOWN_MS = 30_000;
const MAX_PROVIDER_SESSION_AGE_MS = (3600 + 60) * 1000;

function isMissingRateLimitFunction(error) {
  return ['PGRST202', '42883'].includes(error?.code)
    || /claim_realtime_start/i.test(error?.message || '');
}

async function claimRealtimeStart(userId) {
  const { data: claimed, error } = await supabaseAdmin.rpc('claim_realtime_start', { p_user_id: userId });
  if (!error) return { claimed: Boolean(claimed), error: null, fallback: false };
  if (!isMissingRateLimitFunction(error)) return { claimed: false, error, fallback: false };

  // Compatibility path for installations that have not applied the optional
  // atomic limiter migration yet. A successful Start always creates a session
  // row, so the existing table can enforce the same user-facing cooldown.
  const cutoff = new Date(Date.now() - REALTIME_START_COOLDOWN_MS).toISOString();
  const { data: recentSessions, error: fallbackError } = await supabaseAdmin
    .from('sessions')
    .select('id')
    .eq('user_id', userId)
    .gte('start_time', cutoff)
    .order('start_time', { ascending: false })
    .limit(1);
  return {
    claimed: !fallbackError && (recentSessions?.length ?? 0) === 0,
    error: fallbackError,
    fallback: true,
  };
}

function normalizeCredits(value) {
  const credits = Number(value ?? 0);
  return Number.isFinite(credits) ? credits : 0;
}

function getBillableSeconds(startTime) {
  const timestamp = new Date(startTime).getTime();
  if (!Number.isFinite(timestamp)) {
    return 0;
  }

  const elapsedSeconds = Math.floor((Date.now() - timestamp) / 1000);
  const billableSeconds = Math.max(elapsedSeconds - SESSION_BILLING_GRACE_SECONDS, 0);
  return Math.min(billableSeconds, MAX_BILLABLE_SECONDS);
}

async function billAndCloseExistingSession(session, userId, currentCredits) {
  const billableSeconds = getBillableSeconds(session.start_time);
  const creditsToDeduct = Math.min(currentCredits, billableSeconds * CREDITS_PER_SECOND);
  const remainingCredits = currentCredits - creditsToDeduct;

  const { data: closedRows, error: sessionUpdateError } = await supabaseAdmin
    .from('sessions')
    .update({
      end_time: new Date(),
      status: 'ended',
      seconds_used: billableSeconds,
      credits_used: creditsToDeduct,
    })
    .eq('id', session.id)
    .eq('status', 'active')
    .select('id');

  if (sessionUpdateError) {
    throw sessionUpdateError;
  }

  if (!closedRows || closedRows.length === 0) {
    await logPaymentActivity(supabaseAdmin, {
      event: 'orphan_session_close_skipped',
      severity: 'warning',
      userId,
      targetId: session.id,
      message: 'Previous active session was already closed before startup cleanup could bill it',
      payload: { sessionId: session.id },
    });
    return currentCredits;
  }

  if (creditsToDeduct > 0) {
    const { error: walletUpdateError } = await supabaseAdmin
      .from('wallets')
      .update({ credits: remainingCredits })
      .eq('user_id', userId);

    if (walletUpdateError) {
      throw walletUpdateError;
    }
  }

  await logPaymentActivity(supabaseAdmin, {
    event: 'orphan_session_billed_and_closed',
    userId,
    targetId: session.id,
    message: `Previous active session closed and billed ${creditsToDeduct} credits`,
    payload: {
      sessionId: session.id,
      beforeCredits: currentCredits,
      creditsDeducted: creditsToDeduct,
      afterCredits: remainingCredits,
      billableSeconds,
    },
  });

  return remainingCredits;
}

export default async function handler(req, res) {
  const origin = sessionOrigin(req, res);
  if (!origin) return;
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ allowed: false, error: supabaseAdminConfigError || 'Supabase admin is not configured' });
    }

    if (!process.env.MORPHLY_API_KEY?.trim()) {
      return res.status(503).json({ allowed: false, error: 'Missing MORPHLY_API_KEY in server environment' });
    }
    const userId = await sessionUser(req, res, supabaseAdmin);
    if (!userId) return;
    const requestedSeconds = req.body?.maxSessionSeconds ?? req.body?.max_session_seconds ?? 300;
    if (!Number.isInteger(requestedSeconds) || requestedSeconds < 1 || requestedSeconds > 3600) {
      return res.status(400).json({ error: 'maxSessionSeconds must be an integer between 1 and 3600' });
    }
    const model = normalizeMorphlyModel(req.body?.model);
    if (!model) {
      return res.status(400).json({ error: 'Unsupported Morphly model' });
    }
    const imageUrl = req.body?.image_url;
    const editingType = req.body?.editing_type ?? MORPHLY_EDITING_TYPE;
    if (model === 'M2.5') {
      const imageError = validateMorphlyReferenceImage(imageUrl);
      if (imageError) return res.status(400).json({ error: imageError, code: 'INVALID_REFERENCE_IMAGE' });
      if (editingType !== MORPHLY_EDITING_TYPE) {
        return res.status(400).json({ error: 'M2.5 supports subject_replacement only.', code: 'INVALID_EDITING_TYPE' });
      }
    }
    const { claimed, error: limitError, fallback: rateLimitFallback } = await claimRealtimeStart(userId);
    if (limitError) return res.status(503).json({ error: 'Session rate limiter is unavailable. Try again later.' });
    if (!claimed) {
      res.setHeader('Retry-After', '30');
      return res.status(429).json({ error: 'Wait 30 seconds before starting another session' });
    }
    if (rateLimitFallback) console.warn('Using sessions-table realtime start limiter; apply the Morphly migration for atomic claims.');

    await logPaymentActivity(supabaseAdmin, {
      event: 'session_start_requested',
      userId,
      targetId: userId,
      payload: {},
    });

    // Fetch any previous active sessions and the wallet in parallel.
    const [activeSessionsResult, walletResult] = await Promise.all([
      supabaseAdmin
        .from('sessions')
        .select('id, start_time')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('start_time', { ascending: true }),
      supabaseAdmin.from('wallets').select('credits').eq('user_id', userId).maybeSingle(),
    ]);

    if (activeSessionsResult.error) {
      console.error('Failed to load active sessions:', activeSessionsResult.error);
      return res.status(500).json({ allowed: false, error: 'Failed to load active sessions' });
    }

    if (walletResult.error) {
      console.error('Failed to load wallet:', walletResult.error);
      return res.status(500).json({ allowed: false, error: 'Failed to load wallet' });
    }

    const existingActiveSessions = activeSessionsResult.data ?? [];
    const walletNow = walletResult.data;
    if (existingActiveSessions.some((session) => Date.now() - new Date(session.start_time).getTime() < MAX_PROVIDER_SESSION_AGE_MS)) {
      return res.status(409).json({ error: 'An active Morphly session already exists. Stop it before starting again, or wait for its time limit.' });
    }

    let runningCredits = normalizeCredits(walletNow?.credits);
    if (existingActiveSessions && existingActiveSessions.length > 0) {
      try {
        for (const session of existingActiveSessions) {
          runningCredits = await billAndCloseExistingSession(session, userId, runningCredits);
        }
      } catch (cleanupError) {
        console.error('Failed to bill and close previous sessions:', cleanupError);
        await logPaymentActivity(supabaseAdmin, {
          event: 'orphan_session_billing_failed',
          severity: 'error',
          userId,
          targetId: userId,
          message: cleanupError?.message || 'Failed to bill and close previous sessions',
          payload: { activeSessionCount: existingActiveSessions.length },
        });
        return res.status(500).json({ allowed: false, error: 'Failed to close previous sessions' });
      }

      await logPaymentActivity(supabaseAdmin, {
        event: 'orphan_sessions_billed',
        userId,
        targetId: userId,
        message: 'Previous active sessions were billed and closed during a new explicit start',
        payload: {
          activeSessionCount: existingActiveSessions.length,
          sessionIds: existingActiveSessions.map((session) => session.id),
          remainingCredits: runningCredits,
        },
      });
    }

    // Use the already-fetched and post-cleanup-billed credit balance.
    const userCredits = runningCredits;
    if (userCredits <= 0) {
      await logPaymentActivity(supabaseAdmin, {
        event: 'session_start_denied_insufficient_credits',
        severity: 'warning',
        userId,
        targetId: userId,
        payload: { credits: userCredits },
      });
      return res.json({ allowed: false, error: 'Insufficient credits' });
    }

    // Expose a deterministic time budget to the client based on current credits.
    const maxSeconds = Math.min(requestedSeconds, 3600, Math.floor(userCredits / CREDITS_PER_SECOND) + SESSION_BILLING_GRACE_SECONDS);

    const { data: newSession, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert({
        user_id: userId,
        status: 'active',
        start_time: new Date(),
        credits_used: 0,
        seconds_used: 0,
      }).select('id').single();

    if (sessionError) {
      console.error('Failed to create session:', sessionError);
      await logPaymentActivity(supabaseAdmin, {
        event: 'session_start_failed',
        severity: 'error',
        userId,
        targetId: userId,
        message: sessionError.message,
        payload: { credits: userCredits },
      });
      return res.status(500).json({ allowed: false, error: 'Failed to create session' });
    }

    await logPaymentActivity(supabaseAdmin, {
      event: 'session_started',
      userId,
      targetId: newSession.id,
      payload: { sessionId: newSession.id, credits: userCredits, maxSeconds },
    });

    // Keep the full opaque Morphly response for SDK metering and settlement.
    let upstream;
    let payload;
    try {
      upstream = await createMorphlySession({ origin, maxSeconds, model, imageUrl, editingType });
      payload = await upstream.json();
    } catch {
      await supabaseAdmin.from('sessions').update({ status: 'ended', end_time: new Date(), seconds_used: 0, credits_used: 0 }).eq('id', newSession.id);
      return res.status(502).json({ error: 'Morphly session service unavailable. Try Start again later.' });
    }
    if (!upstream.ok) {
      await supabaseAdmin.from('sessions').update({ status: 'ended', end_time: new Date(), seconds_used: 0, credits_used: 0 }).eq('id', newSession.id);
      return res.status(upstream.status).json(payload);
    }
    return res.status(upstream.status).json({ ...payload, allowed: true, sessionId: newSession.id, credits: userCredits, maxSeconds });
  } catch (error) {
    console.error('start-session unexpected error:', error);
    await logPaymentActivity(supabaseAdmin, {
      event: 'session_start_unexpected_error',
      severity: 'error',
      message: error?.message || 'Internal server error',
    });
    res.status(500).json({ allowed: false, error: 'Internal server error' });
  }
}
