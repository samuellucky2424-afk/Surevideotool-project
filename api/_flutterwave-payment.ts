// @ts-nocheck
import { supabaseAdmin } from './_supabase.js';

export async function verifyFlutterwaveTransaction(transactionId, secretKey) {
  const response = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(String(transactionId))}/verify`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json'
    }
  });

  const data = await response.json();
  const transaction = data?.data;
  const status = String(transaction?.status || '').toLowerCase();

  return {
    response,
    data,
    transaction,
    isVerified: response.ok && data?.status === 'success' && (status === 'successful' || status === 'succeeded')
  };
}

export function extractFlutterwavePaymentContext(transaction, fallback = {}) {
  const meta = transaction?.meta && typeof transaction.meta === 'object' ? transaction.meta : {};
  const reference = transaction?.tx_ref || transaction?.reference || fallback.reference || null;

  const metaUserId = meta.userId || meta.user_id || null;
  const fallbackUserId = fallback.userId || null;
  if (metaUserId && fallbackUserId && metaUserId !== fallbackUserId) {
    throw new Error('Payment user mismatch');
  }

  const userId = metaUserId || fallbackUserId;

  const metaCredits = Number(meta.credits);
  const fallbackCredits = Number(fallback.credits);
  if (
    Number.isFinite(metaCredits) &&
    metaCredits > 0 &&
    Number.isFinite(fallbackCredits) &&
    fallbackCredits > 0 &&
    metaCredits !== fallbackCredits
  ) {
    throw new Error('Payment credits mismatch');
  }

  const credits = Number.isFinite(metaCredits) && metaCredits > 0
    ? metaCredits
    : (Number.isFinite(fallbackCredits) && fallbackCredits > 0 ? fallbackCredits : null);

  return { reference, userId, credits };
}

export function validateFlutterwaveTransaction(transaction, expectedReference) {
  const reference = transaction?.tx_ref || transaction?.reference || null;
  if (expectedReference && reference && reference !== expectedReference) {
    return { ok: false, message: 'Payment reference mismatch' };
  }

  if (transaction?.currency && transaction.currency !== 'NGN') {
    return { ok: false, message: 'Unexpected payment currency' };
  }

  const amountPaidNGN = Number(transaction?.amount || 0);
  if (!(amountPaidNGN > 0)) {
    return { ok: false, message: 'Invalid verified amount' };
  }

  return { ok: true, reference: reference || expectedReference, amountPaidNGN };
}

export async function applyVerifiedFlutterwavePayment({ reference, userId, credits, amountPaidNGN }) {
  if (!reference || !userId) {
    throw new Error('Missing payment reference or userId');
  }

  const { data: existingTransaction } = await supabaseAdmin
    .from('transactions')
    .select('id')
    .eq('user_id', userId)
    .eq('reference', reference)
    .eq('status', 'success')
    .maybeSingle();

  if (existingTransaction) {
    const { data: walletData } = await supabaseAdmin
      .from('wallets')
      .select('credits')
      .eq('user_id', userId)
      .single();

    return {
      status: 'success',
      message: 'Payment already verified',
      creditsAdded: 0,
      newCredits: walletData?.credits || 0
    };
  }

  const creditsToAdd = credits || Math.round(amountPaidNGN / 30);

  const { data: walletData } = await supabaseAdmin
    .from('wallets')
    .select('credits')
    .eq('user_id', userId)
    .single();

  const currentCredits = walletData?.credits || 0;
  const newCredits = currentCredits + creditsToAdd;

  await supabaseAdmin.from('wallets').update({ credits: newCredits }).eq('user_id', userId);

  await supabaseAdmin.from('transactions').insert({
    user_id: userId,
    type: 'credit',
    amount: amountPaidNGN,
    credits: creditsToAdd,
    reference,
    status: 'success',
    created_at: new Date()
  });

  const planName = credits ? `${credits} Credits` : 'Credit Purchase';

  await supabaseAdmin.from('subscriptions').insert({
    user_id: userId,
    plan_name: planName,
    amount_paid: amountPaidNGN,
    credits: creditsToAdd,
    status: 'active',
    created_at: new Date()
  });

  return {
    status: 'success',
    message: 'Payment verification successful',
    creditsAdded: creditsToAdd,
    newCredits
  };
}
