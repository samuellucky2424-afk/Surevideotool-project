// @ts-nocheck
import crypto from 'crypto';

import { supabaseAdmin, supabaseAdminConfigError } from './_supabase.js';
import {
  applyVerifiedFlutterwavePayment,
  extractFlutterwavePaymentContext,
  validateFlutterwaveTransaction,
  verifyFlutterwaveTransaction
} from './_flutterwave-payment.js';

function getHeader(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function hasValidFlutterwaveSignature(rawBody, signature, secretHash) {
  if (!signature || !secretHash) return false;
  if (signature === secretHash) return true;

  const expected = crypto.createHmac('sha256', secretHash).update(rawBody).digest('base64');
  if (expected.length !== String(signature).length) return false;

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, flutterwave-signature');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ status: 'failed', message: supabaseAdminConfigError });

  const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;
  const webhookSecretHash = process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH || process.env.FLW_SECRET_HASH;
  if (!flutterwaveSecretKey || !webhookSecretHash) {
    return res.status(500).json({ status: 'failed', message: 'Missing Flutterwave webhook configuration' });
  }

  try {
    const rawBody = await readRawBody(req);
    const signature = getHeader(req, 'flutterwave-signature') || getHeader(req, 'verif-hash');
    if (!hasValidFlutterwaveSignature(rawBody, signature, webhookSecretHash)) {
      return res.status(401).json({ status: 'failed', message: 'Invalid webhook signature' });
    }

    const payload = req.body && typeof req.body === 'object' ? req.body : JSON.parse(rawBody || '{}');
    if (payload?.type && payload.type !== 'charge.completed') {
      return res.status(200).json({ received: true, ignored: true });
    }

    const webhookTransaction = payload?.data || {};
    const webhookStatus = String(webhookTransaction?.status || '').toLowerCase();
    if (webhookStatus && webhookStatus !== 'successful' && webhookStatus !== 'succeeded') {
      return res.status(200).json({ received: true, ignored: true });
    }

    const transactionId = webhookTransaction?.id || webhookTransaction?.transaction_id;
    if (!transactionId) {
      return res.status(400).json({ status: 'failed', message: 'Missing webhook transaction ID' });
    }

    const verification = await verifyFlutterwaveTransaction(transactionId, flutterwaveSecretKey);
    if (!verification.isVerified) {
      return res.status(400).json({ status: 'failed', message: verification.data?.message || 'Payment verification failed' });
    }

    const fallbackReference = webhookTransaction?.tx_ref || webhookTransaction?.reference || null;
    const paymentContext = extractFlutterwavePaymentContext(verification.transaction, {
      reference: fallbackReference,
      userId: webhookTransaction?.meta?.userId || webhookTransaction?.meta?.user_id,
      credits: webhookTransaction?.meta?.credits
    });

    if (!paymentContext.userId) {
      return res.status(400).json({ status: 'failed', message: 'Missing payment userId metadata' });
    }

    const validation = validateFlutterwaveTransaction(verification.transaction, paymentContext.reference);
    if (!validation.ok) {
      return res.status(400).json({ status: 'failed', message: validation.message });
    }

    const result = await applyVerifiedFlutterwavePayment({
      reference: validation.reference,
      userId: paymentContext.userId,
      credits: paymentContext.credits,
      amountPaidNGN: validation.amountPaidNGN
    });

    return res.status(200).json({ received: true, processed: true, ...result });
  } catch (error) {
    return res.status(500).json({ status: 'failed', message: 'Internal server error' });
  }
}
