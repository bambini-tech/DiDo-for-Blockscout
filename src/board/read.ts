/**
 * One read of the entry board: the tokens moving on the four chains, read the
 * way DiDo reads a token, kept when they sit at a good entry.
 *
 *   candidates  GeckoTerminal trending + top volume per chain, DexScreener
 *               boosts, profiles and community takeovers
 *   solid       the pool is real: liquidity, age, volume, two-way trading
 *   entry       the engine (the page's own) puts price in, or just over, a
 *               buy zone with room to the sell level and a score that holds
 *   clean       Blockscout's holder list: ten wallets do not hold most of it
 *
 * Every token read and let go is kept too, with the stage and the reason, so
 * the garden can draw all of it. The thresholds are this edition's own.
 */
import type { Market, DexPair, Frame } from '../market/market.js';
import type { Engine, EngineResult } from './engine.js';
import type { Service } from '../service.js';
import { chainByKey } from '../chains.js';
import { basePayload } from '../holders.js';

export const BOARD_CHAINS = ['ethereum', 'base', 'arbitrum', 'robinhood'] as const;

export const RULES = {
  minLiquidity: 30_000,
  minAgeDays: 2,
  minVolume24: 25_000,
  minLiqMcap: 0.01,
  maxVolLiq: 25,
  minTrades24: 150,
  minScore: 55,
  supportScore: 45,
  nearAbovePct: 5,
  roomPct: { day: 12, weeks: 25 },
  maxTop10Pct: 50,
  establishedLiquidity: 250_000,
  hotHeat: 2,
  maxReads: 60,
};

/** Every let-go reason this read can give; the page words each one (test/web.test.mjs checks). */
export const LET_GO_REASONS = ['no_pair', 'no_info', 'thin_liquidity', 'too_young', 'low_volume', 'thin_vs_mcap', 'one_way', 'thin_exit',
  'few_trades', 'not_read', 'no_data', 'no_setup', 'above_zone', 'under_zone', 'small_room', 'low_score', 'unchecked', 'concentrated'] as const;

/** Majors and stables trend every day and are never a pick. */
const SKIP_SYMBOLS = new Set(['WETH', 'ETH', 'USDC', 'USDT', 'DAI', 'USDE', 'USDBC', 'WBTC', 'CBBTC', 'CBETH', 'WSTETH', 'STETH', 'RETH', 'EURC', 'FRAX', 'USDS', 'TBTC', 'LBTC', 'GHO', 'PYUSD', 'USD0', 'WEETH', 'EZETH']);

export interface BoardDoc {
  read_at: number;
  next_at: number;
  counts: Record<string, number>;
  board: Row[];
  near: Row[];
  support: Row[];
  hot: Record<string, unknown>[];
  let_go: LetGo[];
  calls: Record<string, number>;
}

interface Row {
  chain: string; address: string; symbol: string; name: string; img: string | null; via: string; via_n: null;
  tier: 'entry' | 'near'; above_pct: number; support?: true; lane: 'day' | 'weeks';
  entry: [number, number]; target: [number, number]; upside_pct: number; score: number; price_at_read: number;
  liq: number; size: string; mcap: number | null; age_d: number | null; top10_pct: number | null; tax_pct: null;
}
interface LetGo { chain: string; address: string; symbol: string; liq: number | null; size: string | null; stage: 'solid' | 'entry' | 'clean'; reason: string; measured: Record<string, unknown> }

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const sizeOf = (liq: number) => (liq >= RULES.establishedLiquidity ? 'established' : 'small');

export interface ReadDeps {
  market: Market;
  engine: Engine;
  service: Service;
  now?: () => number;
  intervalMs: number;
}

export async function readBoard(deps: ReadDeps): Promise<BoardDoc> {
  const now = deps.now ?? Date.now;
  const { market, engine } = deps;
  const blockscoutBefore = deps.service.blockscoutCalls;

  // 1. candidates
  const found = new Map<string, { chain: string; address: string; via: string }>();
  const add = (c: { chain: string; address: string; via: string }) => {
    if (!(BOARD_CHAINS as readonly string[]).includes(c.chain) || !/^0x[0-9a-fA-F]{40}$/.test(c.address)) return;
    const k = `${c.chain}:${c.address.toLowerCase()}`;
    if (!found.has(k)) found.set(k, c);
  };
  for (const chain of BOARD_CHAINS) (await market.geckoCandidates(chain)).forEach(add);
  (await market.dexCandidates()).forEach(add);

  // 2. pools: the deepest pool where the token is the base side
  const pairs = new Map<string, DexPair>();
  for (const chain of BOARD_CHAINS) {
    const addrs = [...found.values()].filter((c) => c.chain === chain).map((c) => c.address);
    for (const p of await market.pairs(chain, addrs)) {
      const k = `${chain}:${(p.baseToken?.address ?? '').toLowerCase()}`;
      if (!found.has(k)) continue;
      const prev = pairs.get(k);
      if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) pairs.set(k, p);
    }
  }

  const letGo: LetGo[] = [];
  const hot: Record<string, unknown>[] = [];
  const solid: Array<{ c: { chain: string; address: string; via: string }; p: DexPair; info: Record<string, any> }> = [];

  for (const [k, c] of found) {
    const p = pairs.get(k);
    const symbol = p?.baseToken?.symbol ?? '?';
    if (SKIP_SYMBOLS.has(symbol.toUpperCase())) continue;
    if (!p) { letGo.push({ chain: c.chain, address: c.address, symbol, liq: null, size: null, stage: 'solid', reason: 'no_pair', measured: {} }); continue; }
    const info = engine.tokenInfo(p);
    const liq = p.liquidity?.usd ?? 0;
    const vol24 = p.volume?.h24 ?? 0;
    const mcap = p.marketCap ?? p.fdv ?? 0;
    const h1 = p.txns?.h1 ?? {};
    const h24 = p.txns?.h24 ?? {};
    const trades24 = (h24.buys ?? 0) + (h24.sells ?? 0);
    const ageD = p.pairCreatedAt ? (now() - p.pairCreatedAt) / 86_400_000 : null;
    const measured = {
      age_d: ageD === null ? null : round(ageD), vol_24h: Math.round(vol24), liq_mcap_pct: mcap ? round((liq / mcap) * 100) : null,
      vol_liq: liq ? round(vol24 / liq) : null, trades_24h: trades24, buys_1h: h1.buys ?? 0, sells_1h: h1.sells ?? 0,
    };

    const heat = heatOf(p);
    if (liq >= RULES.minLiquidity && heat >= RULES.hotHeat) {
      hot.push({ chain: c.chain, address: c.address, symbol, name: p.baseToken?.name ?? symbol, img: p.info?.imageUrl ?? null, via: c.via,
        price_at_read: Number(p.priceUsd) || null, liq, size: sizeOf(liq), mcap: mcap || null, heat,
        vol_x: round(velocity(p.volume?.h1 ?? 0, p.volume?.h6 ?? 0, vol24), 2), trades_x: round(velocity(trades(p.txns?.h1), trades(p.txns?.h6), trades24), 2),
        chg_1h: p.priceChange?.h1 ?? null, buys_1h: h1.buys ?? 0, sells_1h: h1.sells ?? 0 });
    }

    const reason =
      !p.info?.imageUrl ? 'no_info'
      : liq < RULES.minLiquidity ? 'thin_liquidity'
      : ageD !== null && ageD < RULES.minAgeDays ? 'too_young'
      : vol24 < RULES.minVolume24 ? 'low_volume'
      : mcap && liq / mcap < RULES.minLiqMcap ? 'thin_vs_mcap'
      : (h1.buys ?? 0) >= 15 && (h1.sells ?? 0) <= 1 ? 'one_way'
      : liq && vol24 / liq > RULES.maxVolLiq ? 'thin_exit'
      : trades24 < RULES.minTrades24 ? 'few_trades'
      : null;
    if (reason) letGo.push({ chain: c.chain, address: c.address, symbol, liq, size: sizeOf(liq), stage: 'solid', reason, measured });
    else solid.push({ c, p, info });
  }

  // 3. the engine, deepest pools first, within the candle budget
  solid.sort((a, b) => (b.p.liquidity?.usd ?? 0) - (a.p.liquidity?.usd ?? 0));
  const atEntry: Array<{ row: Row }> = [];
  let reads = 0;
  for (const { c, p, info } of solid) {
    const symbol = p.baseToken?.symbol ?? '?';
    const liq = p.liquidity?.usd ?? 0;
    const lg = (reason: string, measured: Record<string, unknown> = {}) =>
      letGo.push({ chain: c.chain, address: c.address, symbol, liq, size: sizeOf(liq), stage: 'entry', reason, measured });
    if (reads >= RULES.maxReads) { lg('not_read'); continue; }
    reads++;
    const df1 = await market.candles(p, 1, 500);
    const df4 = df1 ? await market.candles(p, 4, 300) : null;
    if (!df1 || engine.dfLen(df1) < engine.MIN_ANALYSIS_BARS) { lg('no_data'); continue; }
    let res: EngineResult;
    try {
      res = engine.analyze(df1, df4, info.vol_mcap_ratio, info.age_days, info.buys_24h, info.sells_24h,
        { chain: info.chain, address: info.address, asset_class: info.asset_class });
    } catch {
      lg('no_data');
      continue;
    }
    const price = Number(p.priceUsd) || 0;
    const lanes = (['day', 'weeks'] as const).map((lane) => laneOf(res, lane, price)).filter((l): l is Lane => l !== null);
    const m = { score: res.score, day: pick(lanes, 'day'), weeks: pick(lanes, 'weeks') };
    if (!lanes.length) { lg('no_setup', m); continue; }
    const best = lanes.find((l) => l.state === 'entry') ?? lanes.find((l) => l.state === 'near') ?? lanes[0]!;
    if (best.state === 'above') { lg('above_zone', m); continue; }
    if (best.state === 'under') { lg('under_zone', m); continue; }
    if (best.upside_pct < RULES.roomPct[best.lane]) { lg('small_room', m); continue; }
    const supportTier = best.state === 'entry' && res.score >= RULES.supportScore && res.score < RULES.minScore;
    if (res.score < RULES.minScore && !supportTier) { lg('low_score', m); continue; }
    atEntry.push({ row: {
      chain: c.chain, address: p.baseToken?.address ?? c.address, symbol, name: p.baseToken?.name ?? symbol, img: p.info?.imageUrl ?? null,
      via: c.via, via_n: null, tier: best.state === 'entry' ? 'entry' : 'near', above_pct: best.above_pct, ...(supportTier ? { support: true as const } : {}),
      lane: best.lane, entry: [best.lo, best.hi], target: [best.tp, best.tpHigh ?? best.tp], upside_pct: best.upside_pct, score: res.score,
      price_at_read: price, liq, size: sizeOf(liq), mcap: (p.marketCap ?? p.fdv) || null, age_d: info.age_days ?? null, top10_pct: null, tax_pct: null,
    } });
  }

  // 4. holders, from Blockscout
  const picks: Row[] = [];
  for (const { row } of atEntry) {
    const chain = chainByKey(row.chain);
    const tok = chain ? await deps.service.token(chain, row.address.toLowerCase()) : null;
    const lg = (reason: string, measured: Record<string, unknown>) =>
      letGo.push({ chain: row.chain, address: row.address, symbol: row.symbol, liq: row.liq, size: row.size, stage: 'clean', reason, measured });
    if (!tok || tok.kind !== 'ok') { lg('unchecked', { top10_pct: null }); continue; }
    const pair = pairs.get(`${row.chain}:${row.address.toLowerCase()}`)?.pairAddress ?? null;
    const top10 = basePayload(tok.body, pair).top10_pct;
    if (top10 > RULES.maxTop10Pct) { lg('concentrated', { top10_pct: round(top10) }); continue; }
    picks.push({ ...row, top10_pct: round(top10) });
  }

  const board = picks.filter((r) => r.tier === 'entry' && !r.support).sort((a, b) => b.upside_pct - a.upside_pct);
  const near = picks.filter((r) => r.tier === 'near').sort((a, b) => a.above_pct - b.above_pct);
  const support = picks.filter((r) => r.support).sort((a, b) => b.score - a.score);
  hot.sort((a, b) => (b.heat as number) - (a.heat as number));
  const t = now();
  return {
    read_at: Math.floor(t / 1000),
    next_at: Math.floor((t + deps.intervalMs) / 1000),
    counts: { read: pairs.size, solid: solid.length, at_entry: atEntry.length, board: board.length, near: near.length, support: support.length, hot: Math.min(hot.length, 12) },
    board, near, support,
    hot: hot.slice(0, 12),
    let_go: letGo,
    calls: { ...market.calls, engine: reads, blockscout: deps.service.blockscoutCalls - blockscoutBefore },
  };
}

interface Lane { lane: 'day' | 'weeks'; lo: number; hi: number; tp: number; tpHigh: number | null; state: 'entry' | 'near' | 'above' | 'under'; above_pct: number; upside_pct: number }

/** Where price sits against one lane's plan: the watchlist's own rule (in the zone, or within 2% under its floor). */
function laneOf(res: EngineResult, lane: 'day' | 'weeks', price: number): Lane | null {
  const st = lane === 'day';
  const lo = st ? res.stEntryLow : res.ltEntryLow;
  const hi = st ? res.stEntryHigh : res.ltEntryHigh;
  const tp = st ? res.stTpLow : res.ltTpLow;
  const tpHigh = st ? res.stTpHigh : res.ltTpHigh;
  if (lo == null || hi == null || tp == null || !(price > 0)) return null;
  const above = price > hi ? (price / hi - 1) * 100 : 0;
  const state = price < lo * 0.98 ? 'under' : price <= hi ? 'entry' : above <= RULES.nearAbovePct ? 'near' : 'above';
  return { lane, lo, hi, tp, tpHigh, state, above_pct: round(above), upside_pct: round((tp / price - 1) * 100) };
}

function pick(lanes: Lane[], lane: 'day' | 'weeks') {
  const l = lanes.find((x) => x.lane === lane);
  return l ? { above_pct: l.above_pct, upside_pct: l.upside_pct } : undefined;
}

/** How busy a pool is against its usual hour (1 = ordinary): the page's own formula. */
const trades = (w?: { buys?: number; sells?: number }) => (w?.buys ?? 0) + (w?.sells ?? 0);
const velocity = (h1: number, h6: number, h24: number) => h1 / Math.max(h6 > h1 ? (h6 - h1) / 5 : h24 / 24, 1);
export function heatOf(p: DexPair): number {
  const v = p.volume ?? {};
  const t = p.txns ?? {};
  const vx = velocity(v.h1 ?? 0, v.h6 ?? 0, v.h24 ?? 0);
  const tx = velocity(trades(t.h1), trades(t.h6), trades(t.h24));
  return Math.round(Math.sqrt(Math.min(vx, 5) * Math.min(tx, 5)) * 100) / 100;
}

export type { Frame };
