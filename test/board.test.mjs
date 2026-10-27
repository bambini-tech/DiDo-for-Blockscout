import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, scriptedFetch, makeClient } from './helpers.mjs';
import { readBoard, RULES, heatOf } from '../dist/board/read.js';
import { BoardKeeper } from '../dist/board/keeper.js';
import { Market, Pacer } from '../dist/market/market.js';
import { Service } from '../dist/service.js';
import { buildApp } from '../dist/server.js';
import { registerIntel } from '../dist/intel-routes.js';

const NOW = 1_800_000_000_000;
const A = (c) => '0x' + c.repeat(40);
const DAY = 86_400_000;

// A pool that passes every "solid" check unless told otherwise.
const pool = (addr, o = {}) => ({
  chainId: o.chain ?? 'base', pairAddress: '0x' + 'p'.repeat(0) + addr.slice(2, 40) + 'f', priceUsd: String(o.price ?? 1),
  baseToken: { address: addr, symbol: o.symbol ?? addr.slice(2, 5).toUpperCase(), name: 'Tok' },
  liquidity: { usd: o.liq ?? 100_000 }, marketCap: o.mcap ?? 1_000_000,
  volume: { h1: o.v1 ?? 2_000, h6: 12_000, h24: o.v24 ?? 50_000 },
  txns: { h1: { buys: o.b1 ?? 10, sells: o.s1 ?? 10 }, h6: { buys: 60, sells: 60 }, h24: { buys: o.t24 ?? 200, sells: o.t24 ?? 200 } },
  priceChange: { h1: 1, h24: 2 }, pairCreatedAt: NOW - (o.ageD ?? 30) * DAY,
  info: o.noInfo ? {} : { imageUrl: 'https://cdn.dexscreener.com/x.png' },
});

// The engine is stubbed per token: a short-term plan of [lo, hi] -> tp and a score.
function engineFor(plans) {
  return {
    MIN_ANALYSIS_BARS: 15,
    dfLen: (df) => (df ? df.c.length : 0),
    tokenInfo: (p) => ({ chain: p.chainId, address: p.baseToken.address, vol_mcap_ratio: 0, age_days: 30, buys_24h: 1, sells_24h: 1 }),
    analyze: (df1, _df4, _a, _b, _c, _d, tok) => {
      const pl = plans[tok.address];
      return { score: pl.score, stEntryLow: pl.lo ?? null, stEntryHigh: pl.hi ?? null, stTpLow: pl.tp ?? null, stTpHigh: pl.tp ? pl.tp * 1.1 : null,
        ltEntryLow: null, ltEntryHigh: null, ltTpLow: null, ltTpHigh: null };
    },
  };
}
const frame = { t: [1], o: [1], h: [1], l: [1], c: Array(20).fill(1), v: [1] };
function marketWith(pools, { noCandles = [] } = {}) {
  return {
    calls: { dexscreener: 0, gecko: 0, gecko_failed: 0 },
    geckoCandidates: async (chain) => pools.filter((p) => p.chainId === chain).map((p) => ({ chain, address: p.baseToken.address, via: 'trending' })),
    dexCandidates: async () => [],
    pairs: async (chain, addrs) => pools.filter((p) => p.chainId === chain && addrs.includes(p.baseToken.address)),
    candles: async (p) => (noCandles.includes(p.baseToken.address) ? null : frame),
  };
}
// Blockscout: every token's holders are 10 wallets of 3% each, except CONC (one wallet of 80%).
const CONC = A('c');
function blockscout() {
  return scriptedFetch([
    [(u) => u.pathname.endsWith('/holders'), (u) => json({ items: u.pathname.includes(CONC.slice(2))
      ? [{ value: '80', address: { hash: A('9') } }]
      : Array.from({ length: 10 }, (_, i) => ({ value: '3', address: { hash: '0x' + (i + 1).toString(16).repeat(40) } })), next_page_params: null })],
    [(u) => /\/tokens\/0x[0-9a-f]{40}$/i.test(u.pathname), json({ decimals: '0', total_supply: '100', holders_count: '10' })],
  ]);
}

test('tiers: at entry, near, at support -- and every let-go with its stage and reason', async () => {
  const toks = { entry: A('1'), near: A('2'), support: A('3'), low: A('4'), above: A('5'), under: A('6'), room: A('7'), none: A('8'), nodata: A('a'), conc: CONC };
  const plans = {
    [toks.entry]: { score: 60, lo: 0.95, hi: 1.02, tp: 1.4 },
    [toks.near]: { score: 60, lo: 0.9, hi: 0.97, tp: 1.4 },
    [toks.support]: { score: 50, lo: 0.95, hi: 1.02, tp: 1.4 },
    [toks.low]: { score: 40, lo: 0.95, hi: 1.02, tp: 1.4 },
    [toks.above]: { score: 60, lo: 0.8, hi: 0.85, tp: 1.4 },
    [toks.under]: { score: 60, lo: 1.1, hi: 1.2, tp: 1.6 },
    [toks.room]: { score: 60, lo: 0.95, hi: 1.02, tp: 1.05 },
    [toks.none]: { score: 60 },
    [toks.conc]: { score: 60, lo: 0.95, hi: 1.02, tp: 1.4 },
  };
  const pools = Object.values(toks).map((a) => pool(a));
  const doc = await readBoard({ market: marketWith(pools, { noCandles: [toks.nodata] }), engine: engineFor(plans),
    service: new Service(makeClient(blockscout())), intervalMs: 4 * 3600e3, now: () => NOW });
  assert.deepEqual(doc.board.map((r) => r.address), [toks.entry]);
  assert.deepEqual(doc.near.map((r) => r.address), [toks.near]);
  assert.deepEqual(doc.support.map((r) => r.address), [toks.support]);
  const e = doc.board[0];
  assert.equal(e.lane, 'day');
  assert.deepEqual(e.entry, [0.95, 1.02]);
  assert.equal(e.upside_pct, 40);
  assert.equal(e.top10_pct, 30, 'top 10 from Blockscout holders');
  assert.equal(doc.near[0].above_pct, 3.1);
  const why = Object.fromEntries(doc.let_go.map((g) => [g.address, `${g.stage}:${g.reason}`]));
  assert.equal(why[toks.low], 'entry:low_score');
  assert.equal(why[toks.above], 'entry:above_zone');
  assert.equal(why[toks.under], 'entry:under_zone');
  assert.equal(why[toks.room], 'entry:small_room');
  assert.equal(why[toks.none], 'entry:no_setup');
  assert.equal(why[toks.nodata], 'entry:no_data');
  assert.equal(why[toks.conc], 'clean:concentrated');
  assert.equal(doc.counts.board, 1);
  assert.equal(doc.next_at - doc.read_at, 4 * 3600);
});

test('solid: the pool checks, majors skipped, and a missing pool', async () => {
  const t = (c) => A(c);
  const pools = [
    pool(t('1'), { noInfo: true }), pool(t('2'), { liq: 5_000 }), pool(t('3'), { ageD: 0.5 }), pool(t('4'), { v24: 1_000 }),
    pool(t('5'), { b1: 40, s1: 0 }), pool(t('6'), { v24: 4_000_000, liq: 100_000 }), pool(t('7'), { t24: 20 }),
    pool(t('8'), { symbol: 'WETH' }),
  ];
  const market = marketWith(pools);
  const base = market.geckoCandidates;
  market.geckoCandidates = async (chain) => (await base(chain)).concat(chain === 'base' ? [{ chain, address: t('9'), via: 'trending' }] : []);
  const doc = await readBoard({ market, engine: engineFor({}), service: new Service(makeClient(blockscout())), intervalMs: 1, now: () => NOW });
  const why = Object.fromEntries(doc.let_go.map((g) => [g.address, g.reason]));
  assert.deepEqual([t('1'), t('2'), t('3'), t('4'), t('5'), t('6'), t('7'), t('9')].map((a) => why[a]),
    ['no_info', 'thin_liquidity', 'too_young', 'low_volume', 'one_way', 'thin_exit', 'few_trades', 'no_pair']);
  assert.equal(why[t('8')], undefined, 'WETH is never a pick nor a let-go');
});

test('hot: a pool trading far above its usual hour', () => {
  const p = pool(A('1'), { v1: 20_000 });
  p.txns.h1 = { buys: 100, sells: 100 };
  assert.ok(heatOf(p) >= 2);
  assert.ok(heatOf(pool(A('2'))) < 2);
});

test('market: a 429 is retried after the backoff, then answered', async () => {
  let n = 0;
  const waits = [];
  const m = new Market({
    fetch: async () => (n++ === 0 ? new Response('{}', { status: 429 }) : new Response(JSON.stringify({ data: [] }))),
    gtPacer: new Pacer(0), backoffMs: [7], sleep: async (ms) => { waits.push(ms); },
  });
  assert.deepEqual(await m.geckoCandidates('base'), []);
  assert.deepEqual(waits, [7]);
  assert.equal(m.calls.gecko_failed, 0);
});

test('route: "unavailable" until the first read lands, then the board', async () => {
  const pools = [pool(A('1'))];
  const service = new Service(makeClient(blockscout()));
  const keeper = new BoardKeeper({ market: marketWith(pools), engine: engineFor({ [A('1')]: { score: 60, lo: 0.95, hi: 1.02, tp: 1.4 } }), service, intervalMs: 1, now: () => NOW });
  const app = buildApp({ client: makeClient(scriptedFetch([])), version: 't' });
  // a second app wired to this keeper
  const Fastify = (await import('fastify')).default;
  const b = Fastify();
  registerIntel(b, service, { client: makeClient(scriptedFetch([])), configured: true, board: keeper });
  assert.equal((await b.inject('/api/board')).json().error, 'unavailable');
  await keeper.readNow();
  const r = (await b.inject('/api/board')).json();
  assert.equal(r.ok, true);
  assert.equal(r.data.board.length, 1);
  assert.equal((await app.inject('/api/board')).json().error, 'feature_disabled', 'no keeper: no board');
});

test('a round serves what it has so far, never over a complete board; the last board survives a restart', async () => {
  const { mkdtempSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const pools = [pool(A('1'))];
  const deps = () => ({ market: marketWith(pools), engine: engineFor({ [A('1')]: { score: 60, lo: 0.95, hi: 1.02, tp: 1.4 } }),
    service: new Service(makeClient(blockscout())), intervalMs: 1, now: () => NOW });
  const seen = [];
  const doc = await readBoard({ ...deps(), onPartial: (d) => seen.push(d) });
  assert.ok(seen.length >= 1, 'a partial read before the engine runs');
  assert.equal(seen[0].partial, true);
  assert.deepEqual(seen[0].board, [], 'no picks until the round is complete');
  assert.ok(!doc.partial);

  const file = join(mkdtempSync(join(tmpdir(), 'board-')), 'sub', 'board.json');
  const k1 = new BoardKeeper(deps(), () => {}, file);
  await k1.readNow();
  assert.ok(existsSync(file), 'the complete board is saved');
  const k2 = new BoardKeeper(deps(), () => {}, file);
  assert.equal(k2.doc.board.length, 1, 'a restart serves the saved board at once');
  assert.equal(k2.status().ready, true);
});
