// @ts-nocheck
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export class PaymentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function paymentConfig(admin) {
  if (!admin) throw new PaymentError('Payment database is not configured', 503);
  const secret = process.env.PAYSTACK_SECRET_KEY?.trim();
  if (!secret) throw new PaymentError('Paystack is not configured', 503);
  return secret;
}

export async function paymentUser(req, admin) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) throw new PaymentError('Please log in to continue', 401);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user?.email) throw new PaymentError('Please log in again', 401);
  return data.user;
}

async function paystackRequest(path, secret, body) {
  const response = await fetch(`https://api.paystack.co${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.status !== true || !result.data) {
    throw new PaymentError('Paystack could not process this request. Please try again.', 502);
  }
  return result.data;
}

export async function initializePayment(admin, secret, user, planId) {
  if (typeof planId !== 'string' || !/^[0-9a-f-]{36}$/i.test(planId)) {
    throw new PaymentError('Select a valid credit plan');
  }
  const { data: plan, error } = await admin.from('plans')
    .select('id,name,credits,usd_price').eq('id', planId).maybeSingle();
  if (error) throw error;
  if (!plan) throw new PaymentError('This credit plan is no longer available');
  const storedPrice = Number(plan.usd_price);
  // Match the existing pricing display, including legacy USD-style rows.
  const amountNGN = Math.round(storedPrice < 1000 ? storedPrice * 1150 : storedPrice);
  const amountKobo = amountNGN * 100;
  const credits = Number(plan.credits);
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0
      || !Number.isSafeInteger(credits) || credits <= 0) {
    throw new PaymentError('This credit plan has invalid pricing');
  }
  const reference = `svt-${randomUUID()}`;
  // Persist the trusted price and credit snapshot BEFORE contacting Paystack.
  const { error: insertError } = await admin.from('paystack_orders').insert({
    reference, user_id: user.id, email: user.email.toLowerCase(), plan_id: plan.id,
    plan_name: plan.name?.trim() || `${credits} Credits`, credits, amount_kobo: amountKobo, currency: 'NGN',
  });
  if (insertError) throw insertError;
  const data = await paystackRequest('/transaction/initialize', secret, {
    email: user.email, amount: amountKobo, currency: 'NGN', reference,
    metadata: { user_id: user.id, plan_id: plan.id },
  });
  if (!data.access_code || data.reference !== reference) {
    throw new PaymentError('Paystack returned an invalid checkout session', 502);
  }
  return { status: 'success', reference, accessCode: data.access_code, amountNGN, credits };
}

export function validReference(reference) {
  return typeof reference === 'string' && /^svt-[0-9a-f-]{36}$/i.test(reference);
}

export function validateTransaction(transaction, order) {
  if (transaction.reference !== order.reference) throw new PaymentError('Payment reference mismatch');
  if (transaction.status !== 'success') return false;
  if (transaction.currency !== order.currency
      || !Number.isSafeInteger(transaction.amount)
      || transaction.amount !== Number(order.amount_kobo)) {
    throw new PaymentError('Payment amount or currency does not match the order');
  }
  if (transaction.customer?.email?.toLowerCase() !== order.email.toLowerCase()) {
    throw new PaymentError('Payment customer does not match the order');
  }
  return true;
}

export async function verifyPayment(admin, secret, reference, userId = null) {
  if (!validReference(reference)) throw new PaymentError('Invalid payment reference');
  const { data: order, error } = await admin.from('paystack_orders')
    .select('*').eq('reference', reference).maybeSingle();
  if (error) throw error;
  if (!order || (userId && order.user_id !== userId)) {
    throw new PaymentError('Payment was not found for this account', 404);
  }
  const transaction = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, secret);
  if (!validateTransaction(transaction, order)) {
    return { status: 'pending', reference, message: 'Payment is not complete yet. Check again after paying.' };
  }
  // The RPC locks the order and updates the wallet and ledger in one transaction.
  const { data, error: applyError } = await admin.rpc('apply_paystack_payment', {
    p_reference: reference, p_amount_kobo: transaction.amount, p_currency: transaction.currency,
  });
  if (applyError) throw applyError;
  if (!data || data.status !== 'success') throw new Error('Payment database returned an invalid result');
  return data;
}

export function validWebhookSignature(rawBody, signature, secret) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{128}$/i.test(signature)) return false;
  const expected = createHmac('sha512', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export async function readWebhookBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  // Never reconstruct a parsed JSON object: signatures cover the exact bytes.
  if (req.body !== undefined && req.body !== null) throw new PaymentError('Raw webhook body required');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new PaymentError('Webhook payload too large', 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function paymentResponseError(res, error) {
  const statusCode = error instanceof PaymentError ? error.statusCode : 500;
  if (statusCode >= 500) console.error('[paystack]', error.message);
  return res.status(statusCode).json({ status: 'failed', message: statusCode === 500
    ? 'Unable to process payment right now. Please try again.' : error.message });
}

export function paymentCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return false; }
  if (req.method !== 'POST') { res.status(405).json({ message: 'Method not allowed' }); return false; }
  return true;
}

export function createInitializeHandler(admin) {
  return async (req, res) => {
    if (!paymentCors(req, res)) return;
    try {
      const secret = paymentConfig(admin);
      const user = await paymentUser(req, admin);
      return res.json(await initializePayment(admin, secret, user, req.body?.planId));
    } catch (error) { return paymentResponseError(res, error); }
  };
}

export function createVerifyHandler(admin) {
  return async (req, res) => {
    if (!paymentCors(req, res)) return;
    try {
      const secret = paymentConfig(admin);
      const user = await paymentUser(req, admin);
      const result = await verifyPayment(admin, secret, req.body?.reference, user.id);
      return res.status(result.status === 'pending' ? 202 : 200).json(result);
    } catch (error) { return paymentResponseError(res, error); }
  };
}

export function createWebhookHandler(admin) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
    try {
      const secret = paymentConfig(admin);
      const rawBody = await readWebhookBody(req);
      if (!validWebhookSignature(rawBody, req.headers['x-paystack-signature'], secret)) {
        throw new PaymentError('Invalid Paystack signature', 401);
      }
      let event;
      try { event = JSON.parse(rawBody.toString('utf8')); }
      catch { throw new PaymentError('Invalid JSON'); }
      if (event?.event !== 'charge.success' || !validReference(event?.data?.reference)) {
        return res.json({ status: 'ignored' });
      }
      const result = await verifyPayment(admin, secret, event.data.reference);
      // Ask Paystack to retry if its verification API has not caught up yet.
      return res.status(result.status === 'pending' ? 503 : 200).json(result);
    } catch (error) { return paymentResponseError(res, error); }
  };
}
