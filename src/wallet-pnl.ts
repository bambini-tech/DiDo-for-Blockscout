/**
 * The wallet scan's cost basis, booked from the wallet's own Blockscout
 * history (txlist, txlistinternal, tokentx on one chain).
 *
 * Blockscout has no historical prices, so a dollar basis cannot be read; what
 * can be read exactly is what the wallet paid. Every transaction is grouped
 * by hash and its cash side read: the gas coin (plain and internal
 * transfers), the wrapped gas coin, and dollar stablecoins. A transaction
 * that paid cash and received exactly one token is a buy at that cash amount;
 * one that sent exactly one token and received cash is a sell.
 *
 * The approximation is the gas coin's price: cash paid in ETH at some past
 * block is valued at today's ETH price. So a position bought with ETH has an
 * exact percentage (cost and value move with the same price) and an
 * approximate dollar figure; one bought with stablecoins is exact in dollars.
 *
 * What the model cannot value it does not guess: a token that arrived without
 * a readable payment (an airdrop, a bridge, a token-for-token swap, an LP
 * round trip) loses its basis, and so does a position holding more than its
 * observed buys explain. Those rows say "no cost basis" and stay out of the
 * total, which reports how much of the portfolio it covers.
 */
import type { HistoryRow } from './blockscout/wallet.js';

/** Symbols counted as one dollar on the cash side. A stable not listed is a token like any other. */
export const STABLES = new Set([
  'USDC', 'USDC.E', 'USDT', 'USDT0', 'DAI', 'USDS', 'SUSDS', 'FRAX', 'LUSD', 'GUSD', 'PYUSD', 'USDE',
  'SUSDE', 'FDUSD', 'TUSD', 'USDB', 'USDBC', 'EURC', 'USD1', 'RLUSD', 'CRVUSD', 'GHO', 'BUSD', 'DOLA', 'MIM',
]);
/** Below this a cash leg is gas or rounding, not a payment. */
const CASH_DUST_USD = 0.5;
/** Held beyond observed buys minus sells by more than this share: units from elsewhere. */
const QTY_TOLERANCE = 0.02;
const GAS_DECIMALS = 18;

interface Leg {
  /** Gas coin the wallet paid out (positive) or received (negative), in wei. */
  native: bigint;
  in: Map<string, { amount: number; symbol: string }>;
  out: Map<string, { amount: number; symbol: string }>;
  ts: number;
}

export interface Position {
  bought: number;
  costUsd: number;
  sold: number;
  proceedsUsd: number;
  complete: boolean;
  firstTs: number | null;
}

export interface HoldingPnl {
  avg_cost: number;
  basis_usd: number;
  unrealized_usd: number;
  pct: number | null;
  realized_usd: number | null;
  first_ts: number | null;
}

export interface ChainPnl {
  basis_usd: number;
  value_usd: number;
  unrealized_usd: number;
  pct: number | null;
  realized_usd: number;
  positions: number;
  positions_total: number;
  coverage_pct: number | null;
}

const big = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? '0').split('.')[0] || '0');
  } catch {
    return 0n;
  }
};
const lower = (v: unknown) => String(v ?? '').toLowerCase();

/** The three listings regrouped into one entry per transaction hash. */
export function historyLegs(wallet: string, txs: HistoryRow[], internals: HistoryRow[], transfers: HistoryRow[]): Map<string, Leg> {
  const me = wallet.toLowerCase();
  const legs = new Map<string, Leg>();
  const slot = (hash: unknown, ts: unknown): Leg | null => {
    const key = lower(hash);
    if (!key) return null;
    let leg = legs.get(key);
    if (!leg) legs.set(key, (leg = { native: 0n, in: new Map(), out: new Map(), ts: 0 }));
    if (!leg.ts) leg.ts = Number(ts) || 0;
    return leg;
  };
  const failed = (r: HistoryRow) => String(r.isError ?? '0') === '1';

  // Plain transactions key the hash as `hash`, internal ones as `transactionHash`.
  for (const [rows, key] of [[txs, 'hash'], [internals, 'transactionHash']] as const) {
    for (const r of rows) {
      if (failed(r)) continue;
      const leg = slot(r[key] ?? r.hash, r.timeStamp);
      const value = big(r.value);
      if (!leg || value <= 0n) continue;
      if (lower(r.from) === me) leg.native += value;
      else if (lower(r.to) === me) leg.native -= value;
    }
  }

  for (const r of transfers) {
    const leg = slot(r.hash, r.timeStamp);
    const token = lower(r.contractAddress);
    const raw = big(r.value);
    if (!leg || !token || raw <= 0n) continue;
    const side = lower(r.to) === me ? leg.in : lower(r.from) === me ? leg.out : null;
    if (!side) continue;
    const decimals = Number(r.tokenDecimal) || 0;
    const amount = Number(raw) / 10 ** decimals;
    const prev = side.get(token);
    side.set(token, { amount: (prev?.amount ?? 0) + amount, symbol: r.tokenSymbol || prev?.symbol || '?' });
  }
  return legs;
}

/** Average-cost positions per token, from the regrouped history. */
export function bookPositions(legs: Map<string, Leg>, wrapped: string | null, gasUsd: number): Map<string, Position> {
  const positions = new Map<string, Position>();
  const position = (token: string, ts: number) => {
    let p = positions.get(token);
    if (!p) positions.set(token, (p = { bought: 0, costUsd: 0, sold: 0, proceedsUsd: 0, complete: true, firstTs: null }));
    if (ts) p.firstTs = p.firstTs === null ? ts : Math.min(p.firstTs, ts);
    return p;
  };
  const split = (side: Leg['in']) => {
    let cash = 0;
    const assets = new Map<string, number>();
    for (const [token, { amount, symbol }] of side) {
      if (wrapped && token === wrapped) cash += amount * gasUsd;
      else if (STABLES.has(symbol.trim().toUpperCase())) cash += amount;
      else assets.set(token, amount);
    }
    return { cash, assets };
  };

  for (const leg of legs.values()) {
    const out = split(leg.out);
    const inn = split(leg.in);
    const gas = Number(leg.native) / 10 ** GAS_DECIMALS;
    if (gas > 0) out.cash += gas * gasUsd;
    else if (gas < 0) inn.cash += -gas * gasUsd;

    if (inn.assets.size === 1 && out.assets.size === 0 && out.cash > CASH_DUST_USD) {
      const [token, amount] = [...inn.assets][0]!;
      const p = position(token, leg.ts);
      p.bought += amount;
      p.costUsd += out.cash;
    } else if (out.assets.size === 1 && inn.assets.size === 0 && inn.cash > CASH_DUST_USD) {
      const [token, amount] = [...out.assets][0]!;
      const p = position(token, leg.ts);
      p.sold += amount;
      p.proceedsUsd += inn.cash;
    } else {
      // A token moved with no readable payment, or several at once: no basis.
      for (const token of [...inn.assets.keys(), ...out.assets.keys()]) position(token, leg.ts).complete = false;
    }
  }
  return positions;
}

/** One holding's basis, or null when it cannot be stated. */
export function basisFor(p: Position | undefined, held: number, valueUsd: number): HoldingPnl | null {
  if (!p || !p.complete || p.bought <= 0 || p.costUsd <= 0) return null;
  if (held > (p.bought - p.sold) * (1 + QTY_TOLERANCE) + 1e-12) return null;
  const avg = p.costUsd / p.bought;
  const basis = avg * held;
  const unrealized = valueUsd - basis;
  return {
    avg_cost: avg,
    basis_usd: basis,
    unrealized_usd: unrealized,
    pct: basis > 0 ? (unrealized / basis) * 100 : null,
    realized_usd: p.sold > 0 ? p.proceedsUsd - avg * p.sold : null,
    first_ts: p.firstTs,
  };
}

/**
 * Books the basis onto a chain's priced token rows (in place) and returns the
 * chain's roll-up, or null when no row could be given one.
 */
export function attachPnl(
  wallet: string,
  rows: Array<{ address: string; amount: number; usd: number; pnl: HoldingPnl | null }>,
  history: { txs: HistoryRow[]; internals: HistoryRow[]; transfers: HistoryRow[] },
  wrapped: string | null,
  gasUsd: number,
): ChainPnl | null {
  // No token history at all cannot explain a token holding: no basis rather than a zero one.
  if (!history.transfers.length) return null;
  const positions = bookPositions(historyLegs(wallet, history.txs, history.internals, history.transfers), wrapped, gasUsd);
  let basis = 0, value = 0, unrealized = 0, realized = 0, covered = 0;
  for (const row of rows) {
    row.pnl = basisFor(positions.get(row.address.toLowerCase()), row.amount, row.usd);
    if (!row.pnl) continue;
    covered++;
    basis += row.pnl.basis_usd;
    value += row.usd;
    unrealized += row.pnl.unrealized_usd;
    realized += row.pnl.realized_usd ?? 0;
  }
  if (!covered) return null;
  const pricedTotal = rows.reduce((s, r) => s + r.usd, 0);
  return {
    basis_usd: basis,
    value_usd: value,
    unrealized_usd: unrealized,
    pct: basis > 0 ? (unrealized / basis) * 100 : null,
    realized_usd: realized,
    positions: covered,
    positions_total: rows.length,
    coverage_pct: pricedTotal > 0 ? (value / pricedTotal) * 100 : null,
  };
}
