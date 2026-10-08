import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, scriptedFetch, makeClient } from './helpers.mjs';
import { buildApp } from '../dist/server.js';

const TOKEN = '0x' + 'b'.repeat(40);
const routes = () => [
  [(u) => u.pathname.endsWith('/holders'), json({ items: [{ value: '5', address: { hash: '0x' + '1'.repeat(40) } }], next_page_params: null })],
  [`/tokens/${TOKEN}`, json({ address_hash: TOKEN, decimals: '0', total_supply: '10', holders_count: '1', symbol: 'B' })],
];

test('health and chains', async () => {
  const app = buildApp({ client: makeClient(scriptedFetch([])), version: '9.9.9' });
  assert.deepEqual((await app.inject('/health')).json(), { ok: true, version: '9.9.9' });
  const chains = (await app.inject('/api/chains')).json().chains.map((c) => `${c.key}:${c.chainId}`);
  assert.deepEqual(chains, ['eth:1', 'base:8453', 'arbitrum:42161']);
});

test('token: holders with shares, chain block, explorer link base', async () => {
  const f = scriptedFetch(routes());
  const app = buildApp({ client: makeClient(f), version: 't' });
  const res = await app.inject(`/api/token/base/${TOKEN.toUpperCase().replace('0X', '0x')}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.chain.chainId, 8453);
  assert.equal(body.chain.explorer, 'https://base.blockscout.com');
  assert.equal(body.token.symbol, 'B');
  assert.equal(body.holders[0].share, 50);
  assert.ok(f.seen.every((u) => u.pathname.startsWith('/8453/')));
});

test('token: second request is served from cache', async () => {
  const f = scriptedFetch(routes());
  const app = buildApp({ client: makeClient(f), version: 't' });
  await app.inject(`/api/token/eth/${TOKEN}`);
  const n = f.seen.length;
  const again = await app.inject(`/api/token/eth/${TOKEN}`);
  assert.equal(again.headers['x-cache'], 'hit');
  assert.equal(f.seen.length, n);
});

test('token: concurrent requests share one upstream walk', async () => {
  const f = scriptedFetch(routes());
  const app = buildApp({ client: makeClient(f), version: 't' });
  await Promise.all([app.inject(`/api/token/eth/${TOKEN}`), app.inject(`/api/token/eth/${TOKEN}`)]);
  assert.equal(f.seen.length, 2, 'one meta read + one holders page');
});

test('token: bad input, unknown token and outage each get their own answer', async () => {
  const app = buildApp({ client: makeClient(scriptedFetch(routes())), version: 't' });
  assert.equal((await app.inject(`/api/token/solana/${TOKEN}`)).statusCode, 400);
  assert.equal((await app.inject('/api/token/eth/0x123')).statusCode, 400);

  const missing = buildApp({ client: makeClient(scriptedFetch([['/tokens/', json({}, 404)]])), version: 't' });
  const r404 = await missing.inject(`/api/token/eth/${TOKEN}`);
  assert.equal(r404.statusCode, 404);
  assert.equal(r404.json().error, 'token_not_found');

  const down = buildApp({ client: makeClient(scriptedFetch([['/tokens/', json({}, 503)]])), version: 't' });
  const r502 = await down.inject(`/api/token/eth/${TOKEN}`);
  assert.equal(r502.statusCode, 502);
  assert.equal(r502.json().error, 'blockscout_unavailable');
});
