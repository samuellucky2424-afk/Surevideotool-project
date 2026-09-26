import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  createInitializeHandler, createVerifyHandler, createWebhookHandler, createPaymentHandler,
  readWebhookBody, validateTransaction, validWebhookSignature,
} from '../../shared/paystack-payment.ts';

const reference = 'svt-12345678-1234-4234-8234-123456789012';
const userId = '12345678-1234-4234-8234-123456789012';
const planId = '22345678-1234-4234-8234-123456789012';
const secret = 'sk_test_fixture_only';
const order = { reference, user_id: userId, email: 'buyer@example.com', credits: 500, amount_kobo: 1150000, currency: 'NGN' };
const transaction = { reference, status: 'success', amount: 1150000, currency: 'NGN', customer: { email: order.email } };
process.env.PAYSTACK_SECRET_KEY = secret;

function response() {
  return {
    statusCode: 200, body: undefined as any, headers: {} as Record<string, string>,
    setHeader(key: string, value: string) { this.headers[key] = value; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; },
    end() { return this; },
  };
}

function adminStub(options: { userId?: string; insertError?: object; rpcError?: object } = {}) {
  const inserts: any[] = [];
  const rpcCalls: any[] = [];
  const admin = {
    auth: { getUser: async () => ({ data: { user: { id: options.userId || userId, email: order.email } }, error: null }) },
    from(table: string) {
      return {
        select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: table === 'plans'
          ? { id: planId, name: 'Starter', credits: 500, usd_price: 10 } : order, error: null }),
        insert: async (payload: any) => { inserts.push(payload); return { error: options.insertError || null }; },
      };
    },
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      return { data: { status: 'success', creditsAdded: 500, newCredits: 520 }, error: options.rpcError || null };
    },
  };
  return { admin, inserts, rpcCalls };
}

test('both Vercel roots stay within the Hobby function limit and preserve payment URLs', async () => {
  for (const root of ['../../', '../']) {
    const files = await readdir(new URL(`${root}api/`, import.meta.url));
    const endpoints = files.filter(name => name.endsWith('.ts') && !name.startsWith('_'));
    assert.ok(endpoints.length <= 12, `${root} has ${endpoints.length} deployed functions`);
    assert.ok(endpoints.includes('payments.ts'));
    assert.ok(endpoints.includes('paystack-webhook.ts'));
    const config = JSON.parse(await readFile(new URL(`${root}vercel.json`, import.meta.url), 'utf8'));
    assert.deepEqual(config.rewrites.slice(0, 2), [
      { source: '/api/initialize-payment', destination: '/api/payments?action=initialize' },
      { source: '/api/verify-payment', destination: '/api/payments?action=verify' },
    ]);
  }
});

test('combined payment function routes initialization and verification with authentication intact', async (t) => {
  const { admin, rpcCalls, inserts } = adminStub();
  const handler = createPaymentHandler(admin);
  t.mock.method(globalThis, 'fetch', async (url: string, init: any) => {
    if (url.endsWith('/initialize')) {
      return new Response(JSON.stringify({ status: true, data: {
        access_code: 'test-access-code', reference: JSON.parse(init.body).reference,
      } }));
    }
    return new Response(JSON.stringify({ status: true, data: transaction }));
  });
  for (const action of ['initialize', 'verify']) {
    const unauthorized = response();
    await handler({ method: 'POST', headers: {}, query: { action }, body: { planId, reference } }, unauthorized);
    assert.equal(unauthorized.statusCode, 401);
    const res = response();
    await handler({ method: 'POST', headers: { authorization: 'Bearer token' }, query: { action }, body: { planId, reference } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'success');
  }
  assert.equal(inserts.length, 1);
  assert.equal(rpcCalls.length, 1);
  const invalid = response();
  await handler({ method: 'POST', headers: {}, query: { action: 'unknown' } }, invalid);
  assert.equal(invalid.statusCode, 404);
});

test('checkout requires login and CORS preflight does not initialize payment', async () => {
  const { admin, inserts } = adminStub();
  for (const [method, expected] of [['POST', 401], ['OPTIONS', 200], ['GET', 405]] as const) {
    const res = response();
    await createInitializeHandler(admin)({ method, headers: {}, body: { planId } }, res);
    assert.equal(res.statusCode, expected);
  }
  assert.equal(inserts.length, 0);
});

test('checkout uses the authenticated user and server plan price in kobo, ignoring forged amounts', async (t) => {
  const { admin, inserts } = adminStub();
  t.mock.method(globalThis, 'fetch', async (url: string, init: any) => {
    assert.equal(url, 'https://api.paystack.co/transaction/initialize');
    assert.equal(inserts.length, 1, 'order must exist before Paystack initialization');
    const body = JSON.parse(init.body);
    assert.equal(body.amount, 1150000);
    assert.equal(body.email, order.email);
    assert.equal(body.metadata.user_id, userId);
    assert.equal(init.headers.Authorization, `Bearer ${secret}`);
    return new Response(JSON.stringify({ status: true, data: { access_code: 'test-access-code', reference: body.reference } }));
  });
  const res = response();
  await createInitializeHandler(admin)({ method: 'POST', headers: { authorization: 'Bearer token' },
    body: { planId, amountNGN: 1, credits: 999999, userId: 'attacker', email: 'attacker@example.com' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.accessCode, 'test-access-code');
  assert.equal(inserts[0].credits, 500);
  assert.equal(inserts[0].user_id, userId);
  assert.equal(JSON.stringify(res.body).includes(secret), false);
});

test('database failure prevents checkout from starting', async (t) => {
  const { admin } = adminStub({ insertError: new Error('database unavailable') });
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call Paystack'); });
  const res = response();
  await createInitializeHandler(admin)({ method: 'POST', headers: { authorization: 'Bearer token' }, body: { planId } }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(fetch.mock.callCount(), 0);
});

test('verification rejects another user before calling Paystack', async (t) => {
  const { admin, rpcCalls } = adminStub({ userId: 'other-user' });
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call Paystack'); });
  const res = response();
  await createVerifyHandler(admin)({ method: 'POST', headers: { authorization: 'Bearer token' }, body: { reference, userId } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(rpcCalls.length, 0);
});

test('verified payment must match the exact order amount, currency, customer and reference', () => {
  assert.equal(validateTransaction(transaction, order), true);
  assert.equal(validateTransaction({ ...transaction, status: 'failed' }, order), false);
  for (const change of [
    { amount: 1 }, { amount: 1150001 }, { amount: '1150000' },
    { currency: 'USD' }, { currency: undefined }, { reference: 'other-reference' },
    { customer: { email: 'other@example.com' } }, { customer: null },
  ]) assert.throws(() => validateTransaction({ ...transaction, ...change }, order));
});

test('incomplete payment stays pending and cannot credit the wallet', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ status: true, data: { ...transaction, status: 'pending' } })));
  const { admin, rpcCalls } = adminStub();
  const res = response();
  await createVerifyHandler(admin)({ method: 'POST', headers: { authorization: 'Bearer token' }, body: { reference } }, res);
  assert.equal(res.statusCode, 202);
  assert.equal(rpcCalls.length, 0);
});

test('webhook signature covers exact bytes; malformed or missing signatures fail closed', async () => {
  const raw = Buffer.from('{ "event": "charge.success" }');
  const signature = createHmac('sha512', secret).update(raw).digest('hex');
  assert.equal(validWebhookSignature(raw, signature, secret), true);
  for (const invalid of [undefined, '', 'g'.repeat(128), 'a'.repeat(128)]) {
    assert.equal(validWebhookSignature(raw, invalid, secret), false);
  }
  assert.equal(validWebhookSignature(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), signature, secret), false);
  assert.deepEqual(await readWebhookBody(Readable.from([raw.subarray(0, 4), raw.subarray(4)])), raw);
  await assert.rejects(readWebhookBody({ body: JSON.parse(raw.toString()) }), /Raw webhook/);
});

test('invalid signatures and unrelated events never reach verification', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call Paystack'); });
  const { admin, rpcCalls } = adminStub();
  const handler = createWebhookHandler(admin);
  const bad = response();
  await handler({ method: 'POST', headers: {}, body: Buffer.from('{}') }, bad);
  assert.equal(bad.statusCode, 401);
  const raw = Buffer.from(JSON.stringify({ event: 'transfer.success', data: { reference } }));
  const res = response();
  await handler({ method: 'POST', headers: { 'x-paystack-signature': createHmac('sha512', secret).update(raw).digest('hex') }, body: raw }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ignored');
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(rpcCalls.length, 0);
});

test('webhook verifies against Paystack and only acknowledges after the credit transaction succeeds', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, `https://api.paystack.co/transaction/verify/${reference}`);
    return new Response(JSON.stringify({ status: true, data: transaction }));
  });
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference, amount: 1 } }));
  const req = { method: 'POST', body: raw, headers: { 'x-paystack-signature': createHmac('sha512', secret).update(raw).digest('hex') } };
  for (const fail of [false, true]) {
    const { admin, rpcCalls } = adminStub({ rpcError: fail ? new Error('database unavailable') : undefined });
    const res = response();
    await createWebhookHandler(admin)(req, res);
    assert.equal(res.statusCode, fail ? 500 : 200);
    assert.deepEqual(rpcCalls[0], { name: 'apply_paystack_payment', args: { p_reference: reference, p_amount_kobo: 1150000, p_currency: 'NGN' } });
  }
});

test('Postgres migration: replay safety, cumulative top-ups, rollback, price snapshots and permissions', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE wallets (user_id uuid UNIQUE REFERENCES users(id), credits integer NOT NULL CHECK (credits >= 0));
      CREATE TABLE transactions (user_id uuid, type text CHECK (type = 'credit_purchase'), amount_naira numeric,
        credits integer, reference text, description text);
      CREATE TABLE subscriptions (user_id uuid, plan_name text, amount_paid numeric, credits integer, status text);
      INSERT INTO users VALUES ('${userId}');
      INSERT INTO wallets VALUES ('${userId}', 20);
    `);
    const migration = await readFile(new URL('../../supabase/paystack-payments.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration); // Safe to reapply.
    const addOrder = async (ref: string) => db.query(`INSERT INTO paystack_orders
      (reference, user_id, email, plan_id, plan_name, credits, amount_kobo)
      VALUES ($1, $2, $3, $4, 'Starter', 500, 1150000)`, [ref, userId, order.email, planId]);
    const apply = async (ref: string, amount = 1150000, currency: string | null = 'NGN') => {
      const result = await db.query<{ result: any }>('SELECT apply_paystack_payment($1, $2, $3) AS result', [ref, amount, currency]);
      return result.rows[0].result;
    };
    await addOrder(reference);
    await assert.rejects(apply(reference, 1), /mismatch/);
    await assert.rejects(apply(reference, 1150000, null), /mismatch/);
    const results = await Promise.all([apply(reference), apply(reference), apply(reference)]);
    assert.deepEqual(results.map(x => x.creditsAdded), [500, 0, 0]);
    assert.equal(results[2].newCredits, 520);
    assert.equal((await db.query('SELECT * FROM transactions')).rows.length, 1);
    assert.equal((await db.query('SELECT * FROM subscriptions')).rows.length, 1);

    await addOrder('second-order');
    await db.exec(`CREATE FUNCTION reject_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'ledger write failed'; END; $$;
      CREATE TRIGGER reject_ledger BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION reject_ledger();`);
    await assert.rejects(apply('second-order'), /ledger write failed/);
    assert.equal((await db.query<{ credits: number }>('SELECT credits FROM wallets')).rows[0].credits, 520);
    assert.equal((await db.query<{ status: string }>("SELECT status FROM paystack_orders WHERE reference = 'second-order'")).rows[0].status, 'pending');
    await db.exec('DROP TRIGGER reject_ledger ON transactions');
    assert.equal((await apply('second-order')).newCredits, 1020);

    const permissions = await db.query<{ allowed: boolean }>(`SELECT has_function_privilege('authenticated',
      'public.apply_paystack_payment(text,bigint,text)', 'EXECUTE') AS allowed`);
    assert.equal(permissions.rows[0].allowed, false);
    await db.exec('SET ROLE authenticated');
    await assert.rejects(db.query('SELECT * FROM paystack_orders'), /permission denied/);
    await db.exec('RESET ROLE');

    // Also exercise the legacy amount/status transaction layout.
    await db.exec(`ALTER TABLE transactions RENAME COLUMN amount_naira TO amount;
      ALTER TABLE transactions DROP CONSTRAINT transactions_type_check;
      ALTER TABLE transactions ADD COLUMN status text;`);
    await addOrder('legacy-order');
    assert.equal((await apply('legacy-order')).newCredits, 1520);
    const legacy = await db.query<{ type: string; status: string }>("SELECT type,status FROM transactions WHERE reference = 'legacy-order'");
    assert.deepEqual(legacy.rows[0], { type: 'credit', status: 'success' });
  } finally { await db.close(); }
});
