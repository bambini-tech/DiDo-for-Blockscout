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
  assert.deepEqual(chains, ['eth:1', 'base:8453', 'arbitrum:42161', 'robinhood:4663']);
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

test('token: robinhood reads chain 4663 and links its own explorer', async () => {
  const f = scriptedFetch(routes());
  const app = buildApp({ client: makeClient(f), version: 't' });
  const body = (await app.inject(`/api/token/robinhood/${TOKEN}`)).json();
  assert.equal(body.chain.chainId, 4663);
  assert.equal(body.chain.explorer, 'https://robinhoodchain.blockscout.com');
  assert.ok(f.seen.every((u) => u.pathname.startsWith('/4663/')));
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

test('clusters: holders + deployer + traces + sender counts, end to end', async () => {
  const H = (c) => '0x' + c.repeat(40);
  const [h1, h2, h3, pool, s, d] = [H('1'), H('2'), H('3'), H('4'), H('e'), H('d')];
  const txOf = {
    [h1]: [{ from: s, to: h1, value: '5', blockNumber: '10', timeStamp: '1000', isError: '0' }],
    [h2]: [{ from: s, to: h2, value: '6', blockNumber: '20', timeStamp: '90000', isError: '0' }],
    [h3]: [{ from: d, to: h3, value: '7', blockNumber: '30', timeStamp: '1', isError: '0' }],
  };
  const f = scriptedFetch([
    [(u) => u.pathname === '/v2/api', (u) => json({ status: '1', message: 'OK', result: txOf[u.searchParams.get('address')] ?? [] })],
    [(u) => u.pathname.endsWith('/holders'), json({ items: [
      { value: '40', address: { hash: pool, is_contract: true, name: 'Uniswap V2: Pair' } },
      { value: '30', address: { hash: h1 } },
      { value: '20', address: { hash: h2 } },
      { value: '10', address: { hash: h3 } },
    ], next_page_params: null })],
    ['/counters', json({ transactions_count: '12' })],
    [`/addresses/${TOKEN}`, json({ creator_address_hash: d })],
    [`/tokens/${TOKEN}`, json({ address_hash: TOKEN, decimals: '0', total_supply: '100', holders_count: '4', symbol: 'B' })],
  ]);
  const app = buildApp({ client: makeClient(f), version: 't' });
  const res = await app.inject(`/api/clusters/base/${TOKEN}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.deployer.address, d);
  assert.deepEqual(body.analysis.clusters, [{ id: 1, members: [h1, h2], share: 50, reasons: ['shared funder'] }]);
  assert.equal(body.analysis.wallets[h3].deployerFunded, true);
  assert.equal(body.analysis.wallets[pool].trace, 'skipped', 'named pool is not traced');
  assert.equal(body.analysis.stats.deployerLinkedShare, 10);
  assert.equal(body.holders.length, 4, 'the token payload rides along for the map');
  const traced = f.seen.filter((u) => u.searchParams.get('action') === 'txlist').map((u) => u.searchParams.get('address'));
  assert.deepEqual(traced.sort(), [h1, h2, h3]);
  assert.ok(f.seen.some((u) => u.pathname === `/8453/api/v2/addresses/${s}/counters`), 'the shared sender is checked');
  assert.equal(body.calls, f.seen.length);

  const again = await app.inject(`/api/clusters/base/${TOKEN}`);
  assert.equal(again.headers['x-cache'], 'hit');
});

test('clusters: a failed trace is reported and the result is not cached', async () => {
  const H = (c) => '0x' + c.repeat(40);
  const f = scriptedFetch([
    [(u) => u.pathname === '/v2/api', json({}, 503)],
    [(u) => u.pathname.endsWith('/holders'), json({ items: [{ value: '1', address: { hash: H('1') } }], next_page_params: null })],
    [`/addresses/${TOKEN}`, json({ creator_address_hash: null })],
    [`/tokens/${TOKEN}`, json({ address_hash: TOKEN, decimals: '0', total_supply: '1' })],
  ]);
  const app = buildApp({ client: makeClient(f), version: 't' });
  const body = (await app.inject(`/api/clusters/eth/${TOKEN}`)).json();
  assert.equal(body.analysis.stats.failed, 1);
  assert.equal(body.analysis.wallets[H('1')].trace, 'error');
  assert.equal((await app.inject(`/api/clusters/eth/${TOKEN}`)).headers['x-cache'], 'miss');
});
