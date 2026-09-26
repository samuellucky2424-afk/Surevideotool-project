import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { resolveStoredPlanPriceNGN, validPlanPriceNGN, formatNaira } from '../src/lib/pricing.ts';

test('explicit Naira amounts display exactly, with legacy rows preserved', () => {
  assert.equal(resolveStoredPlanPriceNGN(10), 11500);
  assert.equal(resolveStoredPlanPriceNGN(23000, null), 23000);
  assert.equal(resolveStoredPlanPriceNGN(10, 100), 100);
  assert.equal(resolveStoredPlanPriceNGN(10, '100.50'), 100.5);
  assert.equal(formatNaira(100.5), '₦100.5');
  for (const price of [0, -1, Infinity, 'bad', 100.001, 100000000]) {
    assert.equal(validPlanPriceNGN(price), false);
    assert.equal(resolveStoredPlanPriceNGN(10, price), 0);
  }
  for (const price of [0.01, 0.29, 100, 999.99, 1000, 99999999.99]) {
    assert.equal(validPlanPriceNGN(price), true);
  }
});

test('SQL price migration preserves old amounts, authorizes edits, validates and audits exact NGN', async () => {
  const db = new PGlite();
  const adminId = '12345678-1234-4234-8234-123456789012';
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
        SELECT nullif(current_setting('test.user_id', true), '')::uuid;
      $$;
      CREATE FUNCTION public.is_admin(id uuid) RETURNS boolean LANGUAGE sql AS $$
        SELECT id = '${adminId}'::uuid;
      $$;
      CREATE TABLE plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, credits integer, usd_price numeric(10,2));
      CREATE TABLE audit_log (actor_id uuid, action text, target_table text, target_id text, payload jsonb);
      INSERT INTO plans (name, credits, usd_price) VALUES ('Starter',500,10),('Plus',1000,23000);
    `);
    const migration = await readFile(new URL('../../supabase/migrations/20260926213402_plan_prices_ngn.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    const prices = await db.query<{ price_ngn: string }>('SELECT price_ngn FROM plans ORDER BY credits');
    assert.deepEqual(prices.rows.map(row => Number(row.price_ngn)), [11500, 23000]);
    const save = (price: number | string | null, credits = 500) => db.query<{ result: { id: string } }>(
      "SELECT admin_upsert_plan_ngn(NULL, 'Custom', $1, $2) AS result", [credits, price]);
    await assert.rejects(save(100), /Not authorized/);
    await db.exec(`SET test.user_id = '${adminId}'; SET ROLE authenticated;`);
    const created = await save(100);
    const id = created.rows[0].result.id;
    for (const price of [0, -1, null, 'NaN', 'Infinity', 100.001, 100000000]) {
      await assert.rejects(save(price), /Price must/);
    }
    await assert.rejects(save(100, 0), /Credits must/);
    await db.query("SELECT admin_upsert_plan_ngn($1, 'Custom', 500, 100.50)", [id]);
    await db.exec('RESET ROLE');
    await db.exec(migration); // Must not multiply the custom amount on a rerun.
    const row = await db.query<{ price_ngn: string; usd_price: string }>('SELECT price_ngn,usd_price FROM plans WHERE id=$1', [id]);
    assert.equal(Number(row.rows[0].price_ngn), 100.5);
    assert.equal(Number(row.rows[0].usd_price), 100.5);
    assert.equal((await db.query('SELECT * FROM audit_log')).rows.length, 2);
    await db.exec('SET ROLE authenticated');
    await db.query("SELECT admin_upsert_plan($1, 'Custom', 500, 100)", [id]);
    await db.exec("SET test.user_id = '22345678-1234-4234-8234-123456789012'");
    await assert.rejects(save(100), /Not authorized/);
    await db.exec('RESET ROLE');
    const privileges = await db.query<{ allowed: boolean }>(`SELECT has_function_privilege('anon',
      'public.admin_upsert_plan_ngn(uuid,text,integer,numeric)', 'EXECUTE') AS allowed`);
    assert.equal(privileges.rows[0].allowed, false);
  } finally { await db.close(); }
});
