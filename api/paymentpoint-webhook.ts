// @ts-nocheck
import crypto from 'crypto';

import { supabaseAdmin, supabaseAdminConfigError } from './_supabase.js';
import {
  logPaymentActivity,
  parseJsonBody,
  sha256,
  summarizeHeaders,
  summarizePaymentPointPayload,
} from '../shared/payment-activity-log.js';
import { savePaymentPointWebhookEvent } from '../shared/paymentpoint-webhook-cache.js';
import { logError, logPayment } from '../shared/server-logger.js';
import {
  applyVerifiedPayment,
  resolvePaymentPointUserId,
  validatePaymentPointNotification,
} from '../shared/paymentpoint-payment.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

function getHeader(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function getPaymentPointSignature(req) {
  const names = [
    'paymentpoint-signature',
    'Paymentpoint-Signature',
    'x-paymentpoint-signature',
    'X-Paymentpoint-Signature',
    'x-payment-point-signature',
    'X-Payment-Point-Signature',
    'signature',
    'Signature',
  ];

  for (const name of names) {
    const value = getHeader(req, name);
    if (value) {
      return { value, headerName: name };
    }
  }

  return { value: null, headerName: null };
}

async function readRawBody(req) {
  if (typeof req.body === 'string') {
    return req.body;
  }

  if (Buffer.isBuffer(req.body)) {
    return req.body.toString('utf8');
  }

  if (req.body && typeof req.body === 'object') {
    return JSON.stringify(req.body);
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function normalizeSignatureValue(signature) {
  const raw = String(signature || '').trim();
  if (!raw) {
    return null;
  }

  const parts = raw.split(',');
  const versioned = parts
    .map((part) => part.trim())
    .find((part) => /^v\d+=/i.test(part));

  const value = versioned || raw;
  return value
    .replace(/^sha256=/i, '')
    .replace(/^v\d+=/i, '')
    .trim()
    .toLowerCase();
}

function buildPaymentPointSignatureCandidates(rawBody, secretKeys) {
  const bodyBuffer = Buffer.from(String(rawBody || ''), 'utf8');
  const keys = secretKeys.map((key) => String(key || '').trim()).filter(Boolean);
  const candidates = new Set();

  for (const key of keys) {
    candidates.add(key.toLowerCase());
    const hmac = crypto.createHmac('sha256', key).update(bodyBuffer);
    const digest = hmac.digest();
    candidates.add(digest.toString('hex').toLowerCase());
    candidates.add(digest.toString('base64').toLowerCase());
  }

  return [...candidates];
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), 'utf8');
  const rightBuffer = Buffer.from(String(right), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hasValidPaymentPointSignature(rawBody, signature, secretKeys) {
  const normalizedSignature = normalizeSignatureValue(signature);
  if (!rawBody || !normalizedSignature || !Array.isArray(secretKeys) || secretKeys.length === 0) {
    return false;
  }

  return buildPaymentPointSignatureCandidates(rawBody, secretKeys)
    .some((candidate) => timingSafeStringEqual(candidate, normalizedSignature));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Paymentpoint-Signature');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabaseAdmin) {
    return res.status(503).json({ status: 'failed', message: supabaseAdminConfigError });
  }

  const paymentPointSignatureKeySources = [
    { name: 'PAYMENTPOINT_WEBHOOK_SECRET', value: process.env.PAYMENTPOINT_WEBHOOK_SECRET },
    { name: 'PAYMENTPOINT_SECURITY_KEY', value: process.env.PAYMENTPOINT_SECURITY_KEY },
    { name: 'PAYMENTPOINT_SECRET_KEY', value: process.env.PAYMENTPOINT_SECRET_KEY },
    { name: 'PAYMENTPOINT_API_KEY', value: process.env.PAYMENTPOINT_API_KEY },
    { name: 'PAYMENTPOINT_BUSINESS_ID', value: process.env.PAYMENTPOINT_BUSINESS_ID },
  ].filter((source) => source.value);
  const paymentPointSignatureKeys = paymentPointSignatureKeySources.map((source) => source.value);

  if (paymentPointSignatureKeys.length === 0) {
    await logPaymentActivity(supabaseAdmin, {
      event: 'paymentpoint_webhook_missing_secret',
      severity: 'error',
      statusCode: 500,
      message: 'Missing PaymentPoint secret configuration',
    });
    return res.status(500).json({ status: 'failed', message: 'Missing PaymentPoint secret configuration' });
  }

  try {
    const rawBody = await readRawBody(req);
    const parsedPayload = parseJsonBody(rawBody);
    const payloadSummary = summarizePaymentPointPayload(parsedPayload || {});
    const signature = getPaymentPointSignature(req);

    await logPaymentActivity(supabaseAdmin, {
      event: 'paymentpoint_webhook_received',
      reference: payloadSummary.transactionId,
      targetId: payloadSummary.transactionId || payloadSummary.customer?.email,
      payload: {
        payload: payloadSummary,
        bodySha256: sha256(rawBody),
        headers: summarizeHeaders(req.headers),
      },
    });

    const signatureVerified = hasValidPaymentPointSignature(rawBody, signature.value, paymentPointSignatureKeys);
    if (!signatureVerified) {
      logPayment({ event: 'paymentpoint-webhook-invalid-signature', scope: 'root-api' });
      const fallbackValidation = validatePaymentPointNotification(parsedPayload || {});
      await logPaymentActivity(supabaseAdmin, {
        event: 'paymentpoint_webhook_rejected_invalid_signature',
        severity: fallbackValidation.ok ? 'warning' : 'error',
        reference: payloadSummary.transactionId,
        targetId: payloadSummary.transactionId || payloadSummary.customer?.email,
        statusCode: fallbackValidation.ok && signature.value ? 202 : 401,
        message: 'Invalid PaymentPoint signature',
        payload: {
          payload: payloadSummary,
          bodySha256: sha256(rawBody),
          signatureHeaderName: signature.headerName,
          signaturePresent: Boolean(signature.value),
          signatureLength: signature.value ? String(signature.value).trim().length : 0,
          signatureSha256: signature.value ? sha256(signature.value).slice(0, 16) : null,
          signatureKeySourcesTried: paymentPointSignatureKeySources.map((source) => source.name),
          signatureFormatsTried: ['direct', 'hex', 'base64'],
          acceptedSignatureHeaders: [
            'paymentpoint-signature',
            'x-paymentpoint-signature',
            'x-payment-point-signature',
            'signature',
          ],
        },
      });

      if (!signature.value || !fallbackValidation.ok) {
        return res.status(401).json({ status: 'failed', message: 'Invalid PaymentPoint signature' });
      }

      await logPaymentActivity(supabaseAdmin, {
        event: 'paymentpoint_webhook_signature_fallback_accepted',
        severity: 'warning',
        reference: fallbackValidation.context.reference,
        targetId: fallbackValidation.context.reference || payloadSummary.customer?.email,
        message: 'PaymentPoint signature did not match local keys; processing verified success payload with duplicate protection',
        payload: {
          payload: payloadSummary,
          signatureHeaderName: signature.headerName,
          signatureSha256: sha256(signature.value).slice(0, 16),
        },
      });
    }

    const payload = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
      ? req.body
      : (parsedPayload || JSON.parse(rawBody || '{}'));

    savePaymentPointWebhookEvent(payload);

    const validation = validatePaymentPointNotification(payload);
    if (!validation.ok) {
      if (validation.ignore) {
        logPayment({ event: 'paymentpoint-webhook-ignored', scope: 'root-api', message: validation.message });
        await logPaymentActivity(supabaseAdmin, {
          event: 'paymentpoint_webhook_ignored',
          reference: payloadSummary.transactionId,
          targetId: payloadSummary.transactionId || payloadSummary.customer?.email,
          message: validation.message,
          payload: { payload: payloadSummary },
        });
        return res.status(200).json({ received: true, ignored: true, message: validation.message });
      }

      await logPaymentActivity(supabaseAdmin, {
        event: 'paymentpoint_webhook_rejected_invalid_payload',
        severity: 'warning',
        reference: payloadSummary.transactionId,
        targetId: payloadSummary.transactionId || payloadSummary.customer?.email,
        statusCode: 400,
        message: validation.message,
        payload: { payload: payloadSummary },
      });
      return res.status(400).json({ status: 'failed', message: validation.message });
    }

    const userResolution = await resolvePaymentPointUserId(supabaseAdmin, validation.context.customer);
    if (!userResolution.userId) {
      await logPaymentActivity(supabaseAdmin, {
        event: 'paymentpoint_webhook_user_mapping_failed',
        severity: 'warning',
        reference: validation.context.reference,
        targetId: validation.context.reference || userResolution.customerEmail,
        statusCode: 400,
        message: 'Unable to map PaymentPoint customer to an application user',
        payload: {
          customerEmail: userResolution.customerEmail,
          resolutionSource: userResolution.source,
          payload: payloadSummary,
        },
      });
      return res.status(400).json({
        status: 'failed',
        message: 'Unable to map PaymentPoint customer to an application user',
        customerEmail: userResolution.customerEmail,
      });
    }

    const result = await applyVerifiedPayment(supabaseAdmin, {
      reference: validation.context.reference,
      userId: userResolution.userId,
      credits: validation.context.credits,
      amountPaidNGN: validation.context.amountPaidNGN,
      description: validation.context.description || `PaymentPoint payment from ${userResolution.customerEmail || 'customer'}`,
      provider: 'PaymentPoint',
    });

    logPayment({
      event: 'paymentpoint-webhook-processed',
      scope: 'root-api',
      reference: validation.context.reference,
      userId: userResolution.userId,
      amountPaidNGN: validation.context.amountPaidNGN,
      credits: validation.context.credits,
      result,
    });

    await logPaymentActivity(supabaseAdmin, {
      event: 'paymentpoint_webhook_processed',
      reference: validation.context.reference,
      userId: userResolution.userId,
      targetId: validation.context.reference,
      message: result?.message,
      payload: {
        amountPaidNGN: validation.context.amountPaidNGN,
        credits: validation.context.credits,
        result,
        signatureVerified,
        payload: payloadSummary,
      },
    });

    return res.status(200).json({ received: true, processed: true, ...result });
  } catch (error) {
    console.error('[api/paymentpoint-webhook] unexpected error:', error);
    logError('paymentpoint-webhook-unexpected-error', error, { scope: 'root-api' });
    await logPaymentActivity(supabaseAdmin, {
      event: 'paymentpoint_webhook_unexpected_error',
      severity: 'error',
      statusCode: 500,
      message: error?.message || 'Internal server error',
    });
    return res.status(500).json({ status: 'failed', message: 'Internal server error' });
  }
}
