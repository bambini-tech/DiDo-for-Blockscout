import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, scriptedFetch, makeClient } from './helpers.mjs';
import { BlockscoutClient } from '../dist/blockscout/client.js';

test('REST: builds the multichain URL and sends the key', async () => {
  const f = scriptedFetch([['/8453/api/v2/tokens/0xabc', json({ ok: 1 })]]);
  const r = await makeClient(f).rest(8453, 'tokens/0xabc', { limit: 5 });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.data, { ok: 1 });
  assert.equal(f.seen[0].origin, 'https://api.blockscout.com');
  assert.equal(f.seen[0].searchParams.get('apikey'), 'test-key');
  assert.equal(f.seen[0].searchParams.get('limit'), '5');
});

test('404 is "absent", not "error"', async () => {
  const f = scriptedFetch([['/tokens/', json({ message: 'Not found' }, 404)]]);
  const r = await makeClient(f).rest(1, 'tokens/0xabc');
  assert.equal(r.status, 'absent');
  assert.equal(f.seen.length, 1, 'a 404 is an answer and is not retried');
});

test('401/402 is "error" and not retried', async () => {
  const f = scriptedFetch([['/tokens/', json({}, 402)]]);
  const r = await makeClient(f).rest(1, 'tokens/0xabc');
  assert.equal(r.status, 'error');
  assert.equal(f.seen.length, 1);
});

test('429 then 200: retried, honouring Retry-After', async () => {
  let n = 0;
  const f = scriptedFetch([['/tokens/', () => (n++ === 0 ? json({}, 429, { 'retry-after': '2' }) : json({ ok: 1 }))]]);
  const c = makeClient(f);
  const r = await c.rest(1, 'tokens/0xabc');
  assert.equal(r.status, 'ok');
  assert.equal(f.seen.length, 2);
  assert.ok(c.sleeps.includes(2000), `slept ${c.sleeps}`);
});

test('5xx on every attempt gives up as "error" after 3 tries', async () => {
  const f = scriptedFetch([['/tokens/', json({}, 503)]]);
  const r = await makeClient(f).rest(1, 'tokens/0xabc');
  assert.equal(r.status, 'error');
  assert.equal(f.seen.length, 3);
});

test('network errors are retried', async () => {
  let n = 0;
  const f = scriptedFetch([['/tokens/', () => (n++ < 2 ? new TypeError('fetch failed') : json({ ok: 1 }))]]);
  const r = await makeClient(f).rest(1, 'tokens/0xabc');
  assert.equal(r.status, 'ok');
  assert.equal(f.seen.length, 3);
});

test('Etherscan-compat: result on status 1, empty list on "No transactions found"', async () => {
  const f = scriptedFetch([
    [(u) => u.searchParams.get('action') === 'txlist', json({ status: '1', message: 'OK', result: [{ hash: '0x1' }] })],
    [(u) => u.searchParams.get('action') === 'txlistinternal', json({ status: '0', message: 'No transactions found', result: [] })],
    [(u) => u.searchParams.get('action') === 'bad', json({ status: '0', message: 'NOTOK', result: 'Invalid' })],
  ]);
  const c = makeClient(f);
  assert.deepEqual((await c.etherscan(1, { module: 'account', action: 'txlist' })).data, [{ hash: '0x1' }]);
  const empty = await c.etherscan(1, { module: 'account', action: 'txlistinternal' });
  assert.equal(empty.status, 'ok');
  assert.deepEqual(empty.data, []);
  assert.equal((await c.etherscan(1, { module: 'account', action: 'bad' })).status, 'error');
  assert.equal(f.seen[0].pathname, '/v2/api');
  assert.equal(f.seen[0].searchParams.get('chain_id'), '1');
});

test('rate gate spaces concurrent requests at 1/rps', async () => {
  let clock = 1000;
  const sleeps = [];
  const f = scriptedFetch([['/x', json({})]]);
  const c = new BlockscoutClient({
    apiKey: 'k', rps: 4, fetch: f, now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  await Promise.all([c.rest(1, 'x'), c.rest(1, 'x'), c.rest(1, 'x'), c.rest(1, 'x')]);
  assert.deepEqual(sleeps, [250, 500, 750]);
  assert.equal(c.calls, 4);
});

test('the API key never appears in a log line', async () => {
  const lines = [];
  const orig = console.warn;
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'dev';
  console.warn = (m) => lines.push(String(m));
  try {
    const f = scriptedFetch([['/tokens/', () => new TypeError('fetch failed for https://api.blockscout.com/?apikey=test-key')]]);
    await makeClient(f).rest(1, 'tokens/0xabc');
  } finally {
    console.warn = orig;
    process.env.NODE_ENV = env;
  }
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => !l.includes('test-key')), lines.join('\n'));
});
