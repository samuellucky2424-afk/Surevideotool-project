import { randomUUID } from 'node:crypto';
import { DEFAULT_MORPHLY_MODEL } from './morphly-models.js';

export function sessionOrigin(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // These are the app's fixed production and packaged-renderer origins.
  // Keep explicit overrides for local development and custom deployments.
  const origins = [
    process.env.APP_ORIGIN?.trim() || 'https://surevideotool-project.vercel.app',
    process.env.DESKTOP_APP_ORIGIN?.trim() || 'http://127.0.0.1:47831',
  ].map((origin) => origin.replace(/\/+$/, ''));
  const origin = req.headers.origin;
  if (!origin || !origins.includes(origin)) {
    res.status(403).json({ error: 'Origin not allowed. Configure APP_ORIGIN or DESKTOP_APP_ORIGIN.' });
    return null;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  return origin;
}

export async function sessionUser(req, res, supabase) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) {
    res.status(401).json({ error: 'Sign in before starting a session' });
    return null;
  }
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ error: 'Your login has expired. Sign in again.' });
    return null;
  }
  const requestedUser = req.body?.userId || req.query?.userId || req.query?.id;
  if (requestedUser && requestedUser !== data.user.id) {
    res.status(403).json({ error: 'Session access denied' });
    return null;
  }
  return data.user.id;
}

export async function createMorphlySession({ origin, maxSeconds, model = DEFAULT_MORPHLY_MODEL, imageUrl, editingType, fetchImpl = fetch }) {
  return fetchImpl('https://api.morphly.fun/v1/realtime/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MORPHLY_API_KEY.trim()}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({
      model, origin, max_session_seconds: maxSeconds,
      ...(model === 'M2.5' ? { image_url: imageUrl, editing_type: editingType } : {}),
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });
}
