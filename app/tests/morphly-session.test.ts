import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sessionOrigin, sessionUser, createMorphlySession } from '../../shared/morphly-session.js';
import { serveRenderer, closeRenderer } from '../electron/renderer-server.js';
import { normalizeMorphlyModel, validateMorphlyReferenceImage, M25_MAX_IMAGE_BYTES } from '../../shared/morphly-models.js';
import { buildMorphlyConnectOptions, buildMorphlyControls, validateMorphlyImage } from '../src/lib/morphly-controls.ts';

process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
process.env.DESKTOP_APP_ORIGIN = 'http://127.0.0.1:47831';
process.env.MORPHLY_API_KEY = 'morph_test_fixture_only';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fixture-only';

function response() {
  return {
    statusCode: 200, body: undefined as any, headers: {} as Record<string, string>,
    setHeader(key: string, value: string) { this.headers[key] = value; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; },
    end() { return this; },
  };
}

test('only configured browser origins can request credentials', () => {
  for (const origin of ['https://attacker.example', 'null', undefined]) {
    const res = response();
    assert.equal(sessionOrigin({ headers: { origin }, body: { origin: process.env.APP_ORIGIN } }, res), null);
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
  const res = response();
  assert.equal(sessionOrigin({ headers: { origin: process.env.DESKTOP_APP_ORIGIN } }, res), process.env.DESKTOP_APP_ORIGIN);
  assert.equal(res.headers['Access-Control-Allow-Origin'], process.env.DESKTOP_APP_ORIGIN);
});

test('login must be verified and callers cannot impersonate another user', async () => {
  const admin = { auth: { getUser: async () => ({ data: { user: { id: 'real-user' } }, error: null }) } };
  const noLogin = response();
  assert.equal(await sessionUser({ headers: {} }, noLogin, admin), null);
  assert.equal(noLogin.statusCode, 401);
  const forged = response();
  assert.equal(await sessionUser({ headers: { authorization: 'Bearer fixture' }, body: { userId: 'other-user' } }, forged, admin), null);
  assert.equal(forged.statusCode, 403);
});

test('the published desktop and website pass preflight without optional origin overrides', async () => {
  const previousAppOrigin = process.env.APP_ORIGIN;
  const previousDesktopOrigin = process.env.DESKTOP_APP_ORIGIN;
  try {
    delete process.env.APP_ORIGIN;
    delete process.env.DESKTOP_APP_ORIGIN;
    const { default: handler } = await import('../api/start-session.ts');
    for (const origin of ['https://surevideotool-project.vercel.app', 'http://127.0.0.1:47831']) {
      const res = response();
      await handler({ method: 'OPTIONS', headers: { origin } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Access-Control-Allow-Origin'], origin);
      assert.equal(res.headers['Access-Control-Allow-Headers'], 'Content-Type, Authorization');
      assert.equal(res.headers['Cache-Control'], 'no-store');
    }
    for (const origin of ['https://attacker.example', 'http://127.0.0.1:9999', 'null', undefined]) {
      const res = response();
      await handler({ method: 'OPTIONS', headers: { origin } }, res);
      assert.equal(res.statusCode, 403);
    }
    process.env.APP_ORIGIN = ' https://custom.example/ ';
    const res = response();
    assert.equal(sessionOrigin({ headers: { origin: 'https://custom.example' } }, res), 'https://custom.example');
    const oldOrigin = response();
    assert.equal(sessionOrigin({ headers: { origin: 'https://surevideotool-project.vercel.app' } }, oldOrigin), null);
    assert.equal(oldOrigin.statusCode, 403, 'an explicit override replaces the default');
  } finally {
    if (previousAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousAppOrigin;
    if (previousDesktopOrigin === undefined) delete process.env.DESKTOP_APP_ORIGIN;
    else process.env.DESKTOP_APP_ORIGIN = previousDesktopOrigin;
  }
});

test('Morphly requests use fresh idempotency keys and preserve the full opaque response', async () => {
  const requests: any[] = [];
  const payload = { session_id: 's1', client_token: 'opaque-client', session_token: 'opaque-session', balance: { available_credits: 20 } };
  const fetchImpl = async (url: string, options: any) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(payload), { status: 201 });
  };
  const result = await createMorphlySession({ origin: process.env.APP_ORIGIN, maxSeconds: 30, fetchImpl });
  await createMorphlySession({ origin: process.env.APP_ORIGIN, maxSeconds: 30, fetchImpl });
  assert.equal(result.status, 201);
  assert.deepEqual(await result.json(), payload);
  assert.equal(requests[0].url, 'https://api.morphly.fun/v1/realtime/sessions');
  assert.deepEqual(JSON.parse(requests[0].options.body), { model: 'M 2.1', origin: process.env.APP_ORIGIN, max_session_seconds: 30 });
  assert.notEqual(requests[0].options.headers['Idempotency-Key'], requests[1].options.headers['Idempotency-Key']);
});

test('start route enforces limits, forwards provider failures and rolls back local sessions', async (t) => {
  const { supabaseAdmin } = await import('../api/_supabase.ts');
  const { default: handler } = await import('../api/start-session.ts');
  const admin = supabaseAdmin!;
  admin.auth.getUser = async () => ({ data: { user: { id: 'user-1' } }, error: null });
  let limited = false;
  let credits = 100;
  let active: any[] = [];
  let updates = 0;
  let upstreamCalls = 0;
  let upstreamStatus = 201;
  let failNetwork = false;
  let upstreamBody: any;
  let rateLimitClaims = 0;
  let rateLimiterUnavailable = false;
  let recentStarts: any[] = [];
  const payload = { session_id: 'provider-id', session_token: 'opaque-session', client_token: 'opaque-client', expires_at: 'fixture', model: 'morphly-realtime', max_session_seconds: 30, balance: { available_credits: 100 } };
  admin.rpc = async () => {
    rateLimitClaims++;
    return rateLimiterUnavailable
      ? { data: null, error: { code: 'PGRST202', message: 'Could not find claim_realtime_start' } }
      : { data: !limited, error: null };
  };
  admin.from = (table: string) => {
    let operation = 'select';
    let recentStartQuery = false;
    const query: any = {
      select() { return query; }, eq() { return query; }, order() { return query; },
      gte() { recentStartQuery = true; return query; }, limit() { return query; },
      insert() { operation = 'insert'; return query; },
      update() { updates++; operation = 'update'; return query; },
      single() { return query; }, maybeSingle() { return query; },
      then(resolve: any) {
        const data = table === 'wallets' ? { credits } : table === 'sessions' ? operation === 'insert' ? { id: 'local-id' } : operation === 'select' ? recentStartQuery ? recentStarts : active : [] : null;
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return query;
  };
  t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    upstreamCalls++;
    upstreamBody = JSON.parse(init.body);
    if (failNetwork) throw new Error('fixture network failure');
    return new Response(JSON.stringify(upstreamStatus === 201 ? payload : { error: 'Provider denied', code: 'INSUFFICIENT_CREDITS' }), { status: upstreamStatus });
  });
  const invoke = async (body: Record<string, unknown> = { maxSessionSeconds: 30 }) => {
    const res = response();
    await handler({ method: 'POST', headers: { origin: process.env.APP_ORIGIN, authorization: 'Bearer fixture' }, body }, res);
    return res;
  };
  assert.equal((await invoke({ maxSessionSeconds: -1 })).statusCode, 400);
  for (const body of [
    { model: 'unknown' }, { model: false }, { model: 'M2.5' },
    { model: 'M2.5', image_url: 'file:///private/image.png' },
    { model: 'M2.5', image_url: 'https://example.com/subject.png', editing_type: 'clothing' },
  ]) assert.equal((await invoke(body)).statusCode, 400);
  assert.equal(rateLimitClaims, 0, 'invalid input must not consume a start attempt');
  rateLimiterUnavailable = true;
  recentStarts = [{ id: 'recent' }];
  assert.equal((await invoke()).statusCode, 429);
  recentStarts = [];
  rateLimiterUnavailable = false;
  limited = true;
  assert.equal((await invoke()).statusCode, 429);
  limited = false;
  credits = 0;
  assert.equal((await invoke()).body.allowed, false);
  credits = 100;
  active = [{ id: 'active', start_time: new Date().toISOString() }];
  assert.equal((await invoke()).statusCode, 409);
  active = [];
  assert.equal(upstreamCalls, 0);
  const success = await invoke();
  assert.equal(success.statusCode, 201);
  assert.equal(success.body.sessionId, 'local-id');
  for (const [key, value] of Object.entries(payload)) assert.deepEqual(success.body[key], value);
  assert.equal(JSON.stringify(success.body).includes(process.env.MORPHLY_API_KEY!), false);
  assert.equal(upstreamBody.model, 'M 2.1');
  for (const model of ['M2.1', 'M 2.1', 'morphly-realtime', 'lucy-2.5']) {
    assert.equal((await invoke({ model, maxSessionSeconds: 30 })).statusCode, 201);
    assert.equal(upstreamBody.model, model === 'M2.1' ? 'M 2.1' : model);
    assert.equal('image_url' in upstreamBody, false);
  }
  const reference = 'data:image/png;base64,aGVsbG8=';
  for (const model of ['M2.5', 'M 2.5']) {
    const result = await invoke({ model, max_session_seconds: 30, image_url: reference, origin: 'https://attacker.example' });
    assert.equal(result.statusCode, 201);
    assert.deepEqual(upstreamBody, {
      model: 'M2.5', origin: process.env.APP_ORIGIN, max_session_seconds: 30,
      image_url: reference, editing_type: 'subject_replacement',
    });
    for (const [key, value] of Object.entries(payload)) assert.deepEqual(result.body[key], value);
  }
  upstreamStatus = 402;
  const rejected = await invoke();
  assert.equal(rejected.statusCode, 402);
  assert.equal(rejected.body.code, 'INSUFFICIENT_CREDITS');
  assert.equal(updates, 1);
  failNetwork = true;
  assert.equal((await invoke()).statusCode, 502);
  assert.equal(updates, 2);
});

test('model controls send prompts only to M2.1 and image replacement only to M2.5', () => {
  const image = new File(['fixture'], 'subject.png', { type: 'image/png' });
  const transform = { prompt: 'Garment instructions', enhance: false, image };
  assert.deepEqual(buildMorphlyControls('M 2.1', transform), transform);
  assert.deepEqual(buildMorphlyControls('M2.5', transform), { image, editingType: 'subject_replacement' });
  const m21 = buildMorphlyConnectOptions('M 2.1', transform);
  assert.equal(m21.prompt, transform.prompt);
  assert.equal(m21.enhancePrompt, false);
  const m25 = buildMorphlyConnectOptions('M2.5', transform);
  assert.equal('prompt' in m25, false);
  assert.equal('enhancePrompt' in m25, false);
  assert.equal(m25.audio, false);
  assert.equal(m25.model, 'M2.5');
  assert.throws(() => buildMorphlyConnectOptions('M2.5', { ...transform, image: null }), /replacement subject/);
  assert.match(validateMorphlyImage('M2.5', new File(['text'], 'file.txt', { type: 'text/plain' }))!, /image file/);
  const large = new File([new Uint8Array(M25_MAX_IMAGE_BYTES + 1)], 'large.png', { type: 'image/png' });
  assert.match(validateMorphlyImage('M2.5', large)!, /3 MB/);
  assert.equal(validateMorphlyImage('M 2.1', large), null);
});

test('model aliases and reference image validation match the SDK contract', () => {
  assert.equal(normalizeMorphlyModel(), 'M 2.1');
  assert.equal(normalizeMorphlyModel('m 2.5'), 'M2.5');
  assert.equal(normalizeMorphlyModel({}), null);
  for (const image of ['https://example.com/image.png', 'ssupload:?id=fixture', 'data:image/png;base64,aGVsbG8=']) {
    assert.equal(validateMorphlyReferenceImage(image), null);
  }
  for (const image of [null, 42, '', 'blob:fixture', 'https://user:secret@example.com/image.png', 'data:text/plain;base64,aGVsbG8=']) {
    assert.ok(validateMorphlyReferenceImage(image));
  }
  assert.match(validateMorphlyReferenceImage('a'.repeat(4 * 1024 * 1024 + 129))!, /3 MB/);
});

test('root and app deployments share identical session behavior', async () => {
  for (const name of ['start-session', 'end-session', 'session-status']) {
    const root = await readFile(new URL(`../../api/${name}.ts`, import.meta.url), 'utf8');
    const app = await readFile(new URL(`../api/${name}.ts`, import.meta.url), 'utf8');
    assert.equal(root.replaceAll('../shared/', '../../shared/'), app);
  }
});

test('desktop serves built modules over a fixed origin and denies outside files', async () => {
  const root = new URL('../dist', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  try {
    const origin = await serveRenderer(decodeURIComponent(root));
    assert.equal((await fetch(origin)).status, 200);
    assert.equal((await fetch(`${origin}/%2e%2e%5cpackage.json`)).status, 403);
    assert.equal((await fetch(origin, { method: 'POST' })).status, 403);
  } finally {
    await closeRenderer();
  }
});
