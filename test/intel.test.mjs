import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, scriptedFetch, makeClient } from './helpers.mjs';
import { buildApp } from '../dist/server.js';
import { IpLimiter } from '../dist/intel-routes.js';
import { TRANSFER_TOPIC } from '../dist/blockscout/launch.js';

const H = (c) => '0x' + c.repeat(40);
const TOKEN = H('a');
const [h1, h2, h3, h4, pool, s, dev, dead] = [H('1'), H('2'), H('3'), H('4'), H('b'), H('e'), H('d'), '0x000000000000000000000000000000000000dead'];
const CREATION = '0x' + 'c'.repeat(64);
const topic = (a) => '0x' + '0'.repeat(24) + a.slice(2);
const xfer = (from, to, amount, block, ts) => ({
  topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: '0x' + BigInt(amount).toString(16), blockNumber: String(block), timeStamp: String(ts),
});

// A small token: a pool, a burn address, four holders. h1 + h2 share a funder;
// the deployer funded h3 and bundled h1 at launch; h4 sniped 20 s later.
function chainFetch() {
  const txOf = {
    [h1]: [{ from: s, to: h1, value: '5', blockNumber: '10', timeStamp: '1000', isError: '0' }],
    [h2]: [{ from: s, to: h2, value: '6', blockNumber: '20', timeStamp: '90000', isError: '0' }],
    [h3]: [{ from: dev, to: h3, value: '7', blockNumber: '30', timeStamp: '5000', isError: '0' }],
    [h4]: Array.from({ length: 20 }, (_, i) => ({ from: H('9'), to: h4, value: String(i + 1), blockNumber: String(40 + i), timeStamp: String(i), isError: '0' })),
  };
  return scriptedFetch([
    [(u) => u.searchParams.get('action') === 'getLogs', json({ status: '1', message: 'OK', result: [
      xfer(dev, pool, 500, 50, 600), xfer(pool, h1, 100, 51, 700), xfer(pool, h4, 50, 52, 720), xfer(pool, H('8'), 1, 90, 9000),
    ] })],
    [(u) => u.pathname === '/v2/api', (u) => json({ status: '1', message: 'OK', result: txOf[u.searchParams.get('address')] ?? [] })],
    [(u) => u.pathname.endsWith('/holders'), json({ items: [
      { value: '300', address: { hash: pool, is_contract: true, name: 'UniswapV2Pair' } },
      { value: '200', address: { hash: dead } },
      { value: '150', address: { hash: h1 } },
      { value: '120', address: { hash: h2 } },
      { value: '100', address: { hash: h3 } },
      { value: '80', address: { hash: h4 } },
    ], next_page_params: null })],
    ['/counters', json({ transactions_count: '12' })],
    [`/transactions/${CREATION}`, json({ block_number: 49, timestamp: '1970-01-01T00:10:00Z' })],
    [`/addresses/${TOKEN}`, json({ creator_address_hash: dev, creation_transaction_hash: CREATION })],
    [`/tokens/${TOKEN}`, json({ address_hash: TOKEN, decimals: '0', total_supply: '1000', holders_count: '6', symbol: 'TKN', name: 'Token', exchange_rate: '0.5' })],
  ]);
}
const app = (extra = {}) => buildApp({ client: makeClient(chainFetch()), version: 't', ...extra });
const get = async (a, url) => { const r = await a.inject(url); return { status: r.statusCode, body: r.json() }; };

test('base: people only, pools as one LP share, burn left out', async () => {
  const { status, body } = await get(app(), `/api/holder-intel?token=${TOKEN}&chain=ethereum&pair=${pool}`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const d = body.data;
  assert.equal(d.stage, 'base');
  assert.equal(d.chain, 'eth', 'DexScreener ethereum maps to eth');
  assert.deepEqual(d.top_owners.map((o) => [o.address, o.pct, o.rank]), [[h1, 15, 1], [h2, 12, 2], [h3, 10, 3], [h4, 8, 4]]);
  assert.equal(d.lp_pct, 30);
  assert.equal(d.burn_pct, 20);
  assert.equal(d.top10_pct, 45);
  assert.equal(d.concentration, 'Mid');
  assert.equal(d.security, null, 'not read from Blockscout yet: hidden, not guessed');
});

test('full: clusters, links, roles and launch signals from Blockscout', async () => {
  const { body } = await get(app(), `/api/holder-intel?token=${TOKEN}&chain=base&pair=${pool}&stage=full`);
  const d = body.data;
  assert.equal(d.stage, 'full');
  const roles = Object.fromEntries(d.top_owners.map((o) => [o.address, o.roles]));
  assert.deepEqual(roles[h1], ['bundle', 'fresh']);
  assert.deepEqual(roles[h3], ['insider', 'fresh']);
  assert.deepEqual(roles[h4], ['sniper'], 'a full 20-transaction window is not fresh');
  assert.equal(d.launch_ts, 700);
  assert.equal(d.bundle_launch_pct, 10);
  assert.equal(d.sniper_launch_pct, 5);
  assert.equal(d.sniper_now_pct, 8);
  assert.equal(d.insider_pct, 10);
  assert.equal(d.deployer, dev);
  assert.equal(d.dev_found, false);
  assert.deepEqual(d.clusters, [{ pct: 27, wallets: 2, reason: 'shared funder', members: [h1, h2], funder: s,
    funder_is_holder: false, evidence: 'strong', weak_reason: null, owner: null, owner_label: null }]);
  assert.deepEqual(d.links, [{ source: h1, target: h2, kind: 'shared_funder' }]);
  assert.equal(d.bubble_risk, 'High');
  assert.equal(d.top_owners.find((o) => o.address === h1).fund_ts, 1000);
  assert.ok(d.blockscout_calls > 0);
});

test('errors carry the codes the page words', async () => {
  const a = app();
  assert.deepEqual((await get(a, '/api/holder-intel?token=nope&chain=base')).body, { ok: false, error: 'invalid_token', data: null });
  assert.equal((await get(a, `/api/holder-intel?token=${TOKEN}&chain=solana`)).body.error, 'unsupported_chain');
  const off = await get(app({ holderIntel: false }), `/api/holder-intel?token=${TOKEN}&chain=base`);
  assert.equal(off.status, 503);
  assert.equal(off.body.error, 'not_configured');
  const missing = buildApp({ client: makeClient(scriptedFetch([['/tokens/', json({}, 404)]])), version: 't' });
  assert.equal((await get(missing, `/api/holder-intel?token=${TOKEN}&chain=base`)).body.error, 'token_not_found');
  const down = buildApp({ client: makeClient(scriptedFetch([['/tokens/', json({}, 503)]])), version: 't' });
  assert.equal((await get(down, `/api/holder-intel?token=${TOKEN}&chain=base`)).body.error, 'internal');
});

test('uncached full scans are rate limited per IP; cache hits are not', async () => {
  const a = app({ scansPerMinute: 1 });
  assert.equal((await get(a, `/api/holder-intel?token=${TOKEN}&chain=base&stage=full`)).status, 200);
  assert.equal((await get(a, `/api/holder-intel?token=${TOKEN}&chain=base&stage=full`)).status, 200, 'served from cache');
  const other = H('f');
  const r = await get(a, `/api/holder-intel?token=${other}&chain=base&stage=full`);
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'rate_limited');
});

test('progress, board and the mapped-here shelf', async () => {
  const a = app();
  assert.deepEqual((await get(a, `/api/holder-progress?token=${TOKEN}&chain=base`)).body.data, { running: false });
  assert.equal((await get(a, '/api/board')).body.error, 'feature_disabled');
  await a.inject(`/api/holder-intel?token=${TOKEN}&chain=ethereum&stage=full`);
  await a.inject(`/api/holder-intel?token=${TOKEN}&chain=ethereum&stage=full`);
  const shelf = (await get(a, '/api/most-scanned')).body.data;
  assert.equal(shelf.window_h, 24);
  assert.deepEqual(shelf.tokens.map((t) => [t.chain, t.address, t.symbol, t.groups, t.first_price_usd]), [['ethereum', TOKEN, 'TKN', 2, 0.5]]);
});

test('IpLimiter: a fixed window per IP', () => {
  let t = 0;
  const l = new IpLimiter(2, 1000, () => t);
  assert.equal(l.take('a'), true);
  assert.equal(l.take('a'), true);
  assert.equal(l.take('a'), false);
  assert.equal(l.take('b'), true);
  t = 1001;
  assert.equal(l.take('a'), true);
});
