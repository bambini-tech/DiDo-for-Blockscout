/**
 * The wallet scan DiDo's wallet pane reads (GET /api/wallet-scan): one
 * wallet across every chain at once (all of data/chains.json), merged into one portfolio.
 *
 * Where to look comes first, in one request: Blockscout's multichain
 * aggregator says which chains the wallet exists on, and only those are read.
 * Chains the aggregator does not index are probed directly; if the aggregator
 * cannot be read, every chain is probed. Either way no chain the wallet is on
 * is skipped for want of an answer. `discovery` in the result says which way
 * it went.
 *
 * Per chain, from Blockscout: the address (gas coin, its USD rate, identity,
 * and whether it holds any token at all), its transaction count, its token
 * balances (Blockscout leaves out tokens it knows to be scams) and its NFTs.
 *
 * Prices: Blockscout's own USD rate first. On most L2s it carries one only
 * for the majors, so a token without one is looked up on DexScreener (the
 * market data the page's chart already uses): the deepest pool where the token
 * is the base side, never one where it is quoted, whose price would be the
 * other token's. The lookup also gives the token's artwork. A token neither
 * can price is counted in `unpriced`, not shown: airdropped spam is unpriced
 * almost by definition.
 *
 * The cost basis (wallet-pnl.ts) is booked from the wallet's own history on
 * each chain with priced tokens: three Blockscout reads, the slowest of the
 * scan, so they start the moment the balances are in and the card can go out
 * before they finish (`startWalletScan`, the route's `defer=1`).
 *
 * Every number is in the total: dust under $1 is folded into one line, rows
 * past the first 15 into another. A chain that could not be read is listed as
 * failed and missing from the total, never shown as empty. NFTs are listed,
 * never valued; ones named like an advert are counted as hidden.
 */
import { CHAINS, type Chain } from './chains.js';
import type { BlockscoutClient } from './blockscout/client.js';
import { readHistory, readWalletChain, type HistoryRead, type WalletChainRead } from './blockscout/wallet.js';
import { aggregatorChains, aggregatorError, chainsWithAddress, lookupError } from './blockscout/multichain.js';
import { attachPnl, type ChainPnl, type HoldingPnl } from './wallet-pnl.js';
import type { DexPair } from './market/market.js';

const DUST_USD = 1;
const MAX_ROWS = 15;
/** Token contracts priced through DexScreener per chain (30 per request). */
const PRICE_LOOKUPS = 90;
const NFT_ROWS = 120;
const GAS_DECIMALS = 18;

export type Discovery = 'multichain' | 'probe';

/** Market lookups the scan prices with: DexScreener pools for up to 30 tokens per request. */
export interface WalletPricer {
  pairs(chain: string, addresses: string[]): Promise<DexPair[]>;
}

export interface ScanOptions {
  pricer?: WalletPricer | null;
  /** Book the cost basis (three history reads per chain with priced tokens). Default on. */
  pnl?: boolean;
}

export interface Holding {
  address: string | null;
  symbol: string;
  name: string | null;
  amount: number;
  holders: number | null;
  price_usd: number | null;
  price_source: 'blockscout' | 'dexscreener' | null;
  logo: string | null;
  usd: number;
  pnl: HoldingPnl | null;
  native: boolean;
  chain: string;
  chain_label: string;
  pct?: number;
}

interface Nft {
  chain: string;
  chain_label: string;
  collection: string;
  collection_address: string;
  symbol: string;
  type: string;
  token_id: string;
  name: string;
  image: string | null;
  amount: number;
  holders: number | null;
}

interface ChainEntry {
  chain: string;
  chain_name: string;
  chain_label: string;
  native_symbol: string;
  is_contract: boolean;
  name: string | null;
  ens: string | null;
  tags: string[];
  tx_count: number | null;
  native: { amount: number; price_usd: number | null; usd: number };
  native_source: Holding['price_source'];
  holdings: Holding[];
  unpriced: number;
  tokens_usd: number;
  total_usd: number;
  pnl: ChainPnl | null;
  /** Why the cost basis could not be read on this chain, in Blockscout's words. */
  pnl_error?: string;
  nfts: Nft[];
  nfts_more: boolean;
  nfts_hidden: number;
  notes: string[];
}

export type WalletScan = ReturnType<typeof assemble>;

/** The whole scan, cost basis included. */
export async function scanWallet(client: BlockscoutClient, wallet: string, chains: readonly Chain[] = CHAINS, discovery: Discovery = 'multichain', opts: ScanOptions = {}): Promise<WalletScan> {
  const { card, finished } = await startWalletScan(client, wallet, chains, discovery, opts);
  return finished ? await finished : card;
}

/**
 * The card as soon as balances, prices and NFTs are in (`pnl_pending` while a
 * basis is still booking), and the finished scan behind it, or null when
 * there is no basis to book.
 */
export async function startWalletScan(client: BlockscoutClient, wallet: string, chains: readonly Chain[] = CHAINS, discovery: Discovery = 'multichain', opts: ScanOptions = {}) {
  const address = wallet.toLowerCase();
  const plan = await planChains(client, address, chains, discovery);
  const skipped: WalletChainRead = { status: 'absent', address: null, txCount: null, tokens: [], tokensOk: true, nfts: [], nftsMore: false };
  const withPnl = opts.pnl !== false;

  const reads = await Promise.all(chains.map(async (c) => {
    const r = plan.read.has(c.chainId) ? await readWalletChain(client, c.chainId, address) : skipped;
    // The history goes in first: its reads are the slowest, and the pricing below does not need them.
    const history = withPnl && r.status === 'ok' && r.tokens.some((t) => !t.scam) ? readHistory(client, c.chainId, address) : null;
    const priced = r.status === 'ok' && r.address ? await priceChain(c, r, opts.pricer ?? null) : null;
    return { c, r, history, priced };
  }));

  // Chains sharing a gas coin share its price: one ETH price serves an ETH chain whose row lacks it.
  const gas = new Map<string, { usd: number; source: Holding['price_source'] }>();
  for (const { c, priced } of reads) if (priced?.gasUsd && !gas.has(c.native)) gas.set(c.native, { usd: priced.gasUsd, source: priced.gasSource });

  const entries: ChainEntry[] = [];
  const histories = new Map<string, Promise<HistoryRead>>();
  const empty: string[] = [];
  const failed: string[] = [];
  for (const { c, r, history, priced } of reads) {
    if (r.status === 'error') { failed.push(c.key); continue; }
    if (!r.address || !priced) { empty.push(c.key); continue; }
    const own = priced.gasUsd ? { usd: priced.gasUsd, source: priced.gasSource } : null;
    const entry = chainEntry(c, r, priced, own ?? gas.get(c.native) ?? null);
    if (!(entry.total_usd > 0 || entry.holdings.length || entry.unpriced || entry.nfts.length)) { empty.push(c.key); continue; }
    entries.push(entry);
    if (history && entry.holdings.length) histories.set(c.key, history);
  }
  entries.sort((a, b) => b.total_usd - a.total_usd || b.nfts.length - a.nfts.length);

  const card = assemble(address, entries, empty, failed, plan.info, histories.size > 0);
  if (!histories.size) return { card, finished: null };
  const finished = Promise.all(entries.map(async (e) => {
    const h = histories.get(e.chain);
    return h ? withBasis(address, e, await h, chains) : e;
  })).then((booked) => assemble(address, booked, empty, failed, plan.info, false));
  return { card, finished };
}

/** A chain's tokens, priced: Blockscout's rate, then DexScreener for what it lacks. */
async function priceChain(c: Chain, r: WalletChainRead, pricer: WalletPricer | null) {
  const label = c.label;
  const rows: Holding[] = r.tokens.filter((t) => !t.scam).map((t) => ({
    address: t.address,
    symbol: t.symbol || '?',
    name: t.name,
    amount: Number(BigInt(t.raw)) / 10 ** t.decimals,
    holders: t.holders !== null && Number.isFinite(Number(t.holders)) ? Number(t.holders) : null,
    price_usd: t.priceUsd,
    price_source: t.priceUsd ? 'blockscout' : null,
    logo: t.logo,
    usd: 0,
    pnl: null,
    native: false,
    chain: c.key,
    chain_label: label,
  }));
  let gasUsd = r.address?.nativeUsd ?? null;
  let gasSource: Holding['price_source'] = gasUsd ? 'blockscout' : null;
  const notes: string[] = [];

  // Unpriced first, by holder count (a real token has holders, a dropped one hardly any);
  // priced rows fill what is left, for their artwork. The wrapped gas coin rides along
  // when Blockscout gave no gas price.
  const known = (h: Holding) => (h.price_usd ?? 0) * h.amount;
  const unpriced = rows.filter((h) => !h.price_usd).sort((a, b) => (b.holders ?? 0) - (a.holders ?? 0));
  const priced = rows.filter((h) => h.price_usd).sort((a, b) => known(b) - known(a));
  const lookups = [...unpriced, ...priced].slice(0, PRICE_LOOKUPS).map((h) => h.address!);
  if (!gasUsd && c.wrapped) lookups.unshift(c.wrapped);
  if (pricer && lookups.length) {
    let pairs: DexPair[] = [];
    try {
      pairs = await pricer.pairs(c.key, [...new Set(lookups)]);
    } catch {
      notes.push(`${label}: some token prices could not be read just now`);
    }
    const best = deepestBasePools(pairs, c.key);
    for (const h of rows) {
      const p = best.get(h.address!);
      if (!p) continue;
      const image = (p.info?.imageUrl ?? '').trim();
      if (image.startsWith('https://')) h.logo = image;
      if (h.price_usd) continue;
      const price = Number(p.priceUsd);
      if (!(price > 0)) continue;
      h.price_usd = price;
      h.price_source = 'dexscreener';
      if (h.symbol === '?' && p.baseToken?.symbol) h.symbol = p.baseToken.symbol;
    }
    if (!gasUsd && c.wrapped) {
      const price = Number(best.get(c.wrapped)?.priceUsd);
      if (price > 0) [gasUsd, gasSource] = [price, 'dexscreener'];
    }
  }
  return { rows, gasUsd, gasSource, notes };
}

/** The deepest pool per token where that token is the base side, by lowercase address. */
function deepestBasePools(pairs: DexPair[], chain: string): Map<string, DexPair> {
  const out = new Map<string, DexPair>();
  for (const p of pairs) {
    if ((p.chainId ?? '').toLowerCase() !== chain) continue;
    const token = (p.baseToken?.address ?? '').toLowerCase();
    if (!token) continue;
    const prev = out.get(token);
    if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) out.set(token, p);
  }
  return out;
}

function chainEntry(c: Chain, r: WalletChainRead, priced: { rows: Holding[]; notes: string[] }, gas: { usd: number; source: Holding['price_source'] } | null): ChainEntry {
  const gasUsd = gas?.usd ?? null;
  const holdings = priced.rows.filter((h) => h.price_usd);
  for (const h of holdings) h.usd = h.amount * h.price_usd!;
  holdings.sort(byUsd);
  const gasAmount = Number(r.address!.coinWei) / 10 ** GAS_DECIMALS;
  const gasValue = gasUsd ? gasAmount * gasUsd : 0;
  const tokensUsd = holdings.reduce((s, h) => s + h.usd, 0);
  const { nfts, hidden } = cleanNfts(c, r.nfts);
  const notes = [...priced.notes];
  if (!r.tokensOk) notes.push(`${c.label}: token balances could not be read, so this chain's total is short`);
  return {
    chain: c.key,
    chain_name: c.name,
    chain_label: c.label,
    native_symbol: c.native,
    is_contract: r.address!.isContract,
    name: r.address!.name,
    ens: r.address!.ens,
    tags: r.address!.tags,
    tx_count: r.txCount,
    native: { amount: gasAmount, price_usd: gasUsd, usd: gasValue },
    native_source: gas?.source ?? null,
    holdings,
    unpriced: priced.rows.length - holdings.length,
    tokens_usd: tokensUsd,
    total_usd: tokensUsd + gasValue,
    pnl: null,
    nfts: rankNfts(nfts),
    nfts_more: r.nftsMore,
    nfts_hidden: hidden,
    notes,
  };
}

/** The entry with its basis booked, on copied rows: the card may already be out with the old ones. */
function withBasis(wallet: string, e: ChainEntry, h: HistoryRead, chains: readonly Chain[]): ChainEntry {
  const holdings = e.holdings.map((x) => ({ ...x }));
  const notes: string[] = [];
  let pnl: ChainPnl | null = null;
  let pnlError: string | undefined;
  if (h.status !== 'ok') {
    notes.push(`${e.chain_label}: cost basis unavailable`);
    pnlError = h.error ?? 'error';
  }
  else if (h.truncated) notes.push(`history too long to price (>10,000 ${h.truncated})`);
  else {
    if (h.internalsPending) notes.push(`${e.chain_label}: Blockscout is still indexing internal transactions here, so a sale paid in ${e.native_symbol} may show no cost basis yet`);
    const wrapped = chains.find((c) => c.key === e.chain)?.wrapped ?? null;
    pnl = attachPnl(wallet, holdings as Array<{ address: string; amount: number; usd: number; pnl: HoldingPnl | null }>, h, wrapped, e.native.price_usd ?? 0);
  }
  return { ...e, holdings, pnl, ...(pnlError ? { pnl_error: pnlError } : {}), notes: [...notes, ...e.notes] };
}

/** What an airdropped advert calls itself: a link, a domain, or a call to claim something. */
const NFT_SPAM = /(https?:\/\/|www\.|t\.me\/|\.(com|io|net|org|xyz|app|site|online|fun|top|click|gift|live|claim|finance|pro|vip|cc)\b|\b(claim|reward|rewards|voucher|redeem|airdrop|visit|giveaway|bonus)\b)/i;

function cleanNfts(c: Chain, raw: WalletChainRead['nfts']): { nfts: Nft[]; hidden: number } {
  const nfts: Nft[] = [];
  let hidden = 0;
  for (const n of raw) {
    if (NFT_SPAM.test([n.collection, n.symbol, n.name].filter(Boolean).join(' '))) { hidden++; continue; }
    const collection = n.collection || n.symbol || 'Unnamed collection';
    nfts.push({
      chain: c.key,
      chain_label: c.label,
      collection,
      collection_address: n.collection_address,
      symbol: n.symbol ?? '',
      type: n.type,
      token_id: n.token_id,
      name: n.name || `${collection} #${shortId(n.token_id)}`,
      image: n.image,
      amount: n.amount,
      holders: n.holders,
    });
  }
  return { nfts, hidden };
}

const shortId = (id: string) => (id.length <= 12 ? id : `${id.slice(0, 5)}…${id.slice(-4)}`);

/** Collections together, the most widely held first; pictures before placeholders, then by id. */
function rankNfts(nfts: Nft[]): Nft[] {
  const groups = new Map<string, Nft[]>();
  for (const n of nfts) {
    const k = `${n.chain}:${n.collection_address.toLowerCase()}`;
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  const idKey = (n: Nft) => n.token_id.padStart(80, '0');
  return [...groups.values()]
    .sort((a, b) => (b[0]!.holders ?? 0) - (a[0]!.holders ?? 0) || b.length - a.length || a[0]!.collection.toLowerCase().localeCompare(b[0]!.collection.toLowerCase()))
    .flatMap((g) => g.sort((a, b) => Number(a.image === null) - Number(b.image === null) || idKey(a).localeCompare(idKey(b))));
}

function assemble(address: string, entries: ChainEntry[], empty: string[], failed: string[], discovery: PlanInfo, pnlPending: boolean) {
  const rows: Holding[] = [];
  for (const c of entries) {
    if (c.native.amount > 0) {
      rows.push({
        address: null, symbol: c.native_symbol, name: c.native_symbol, amount: c.native.amount, holders: null,
        price_usd: c.native.price_usd, price_source: c.native_source, logo: null,
        usd: c.native.usd, pnl: null, native: true, chain: c.chain, chain_label: c.chain_label,
      });
    }
    rows.push(...c.holdings.map((h) => ({ ...h })));
  }
  const total = entries.reduce((s, c) => s + c.total_usd, 0);
  const tokens = entries.reduce((s, c) => s + c.tokens_usd, 0);
  for (const r of rows) r.pct = total > 0 ? (r.usd / total) * 100 : 0;
  rows.sort(byUsd);
  const above = rows.filter((r) => r.usd >= DUST_USD);
  const dust = rows.filter((r) => r.usd < DUST_USD);
  const overflow = above.slice(MAX_ROWS);

  const nfts = rankNfts(entries.flatMap((c) => c.nfts));
  const covered = entries.map((c) => c.pnl).filter((p): p is ChainPnl => p !== null);
  let pnl = null;
  if (covered.length) {
    const basis = covered.reduce((s, p) => s + p.basis_usd, 0);
    const unrealized = covered.reduce((s, p) => s + p.unrealized_usd, 0);
    const value = covered.reduce((s, p) => s + p.value_usd, 0);
    pnl = {
      basis_usd: basis,
      value_usd: value,
      unrealized_usd: unrealized,
      pct: basis > 0 ? (unrealized / basis) * 100 : null,
      realized_usd: covered.reduce((s, p) => s + p.realized_usd, 0),
      positions: covered.reduce((s, p) => s + p.positions, 0),
      positions_total: entries.reduce((s, c) => s + c.holdings.length, 0),
      coverage_pct: tokens > 0 ? (value / tokens) * 100 : null,
      chains: entries.filter((c) => c.pnl).map((c) => c.chain),
    };
  }

  const notes = entries.flatMap((c) => c.notes);
  if (failed.length) {
    const labels = failed.map((k) => CHAINS.find((c) => c.key === k)?.label ?? k).join(', ');
    const one = failed.length === 1;
    notes.push(`${labels}: could not be read, so ${one ? 'this chain was' : 'these chains were'} NOT scanned — anything held there is missing from the total`);
  }
  const txCount = entries.reduce((s, c) => s + (c.tx_count ?? 0), 0);

  return {
    address,
    ens: entries.find((c) => c.ens)?.ens ?? null,
    name: entries.find((c) => c.name)?.name ?? null,
    tags: [...new Set(entries.flatMap((c) => c.tags))],
    is_contract: entries.some((c) => c.is_contract),
    tx_count: txCount || null,
    total_usd: total,
    tokens_usd: tokens,
    native_usd: total - tokens,
    chains: entries,
    empty_chains: empty,
    failed_chains: failed,
    holdings: above.slice(0, MAX_ROWS),
    dust: dust.length,
    dust_usd: dust.reduce((s, r) => s + r.usd, 0),
    more: overflow.length,
    more_usd: overflow.reduce((s, r) => s + r.usd, 0),
    unpriced: entries.reduce((s, c) => s + c.unpriced, 0),
    pnl,
    nfts: nfts.slice(0, NFT_ROWS),
    nft_count: nfts.length,
    nft_collections: new Set(nfts.map((n) => `${n.chain}:${n.collection_address.toLowerCase()}`)).size,
    nfts_more: entries.some((c) => c.nfts_more),
    nfts_hidden: entries.reduce((s, c) => s + c.nfts_hidden, 0),
    notes,
    error: null,
    pnl_pending: pnlPending,
    source: 'blockscout' as const,
    discovery,
  };
}

const byUsd = (a: { usd: number }, b: { usd: number }) => b.usd - a.usd;

type PlanInfo =
  | { via: 'probe'; probed: number; reason?: string }
  | { via: 'multichain'; found_on: number; probed: number; skipped: number };

/** Which chains to read: the ones the aggregator places the wallet on, plus every chain it does not index. */
async function planChains(client: BlockscoutClient, address: string, chains: readonly Chain[], discovery: Discovery): Promise<{ read: Set<number>; info: PlanInfo }> {
  const all = new Set(chains.map((c) => c.chainId));
  if (discovery === 'probe') return { read: all, info: { via: 'probe', probed: all.size } };
  const indexed = await aggregatorChains(client);
  if (!indexed) return { read: all, info: { via: 'probe', probed: all.size, reason: `aggregator chain list unavailable (${aggregatorError() ?? 'error'})` } };
  const covered = chains.filter((c) => indexed.has(c.chainId)).map((c) => c.chainId);
  const present = await chainsWithAddress(client, address, covered);
  if (!present) return { read: all, info: { via: 'probe', probed: all.size, reason: `aggregator lookup failed (${lookupError() ?? 'error'})` } };
  const uncovered = chains.filter((c) => !indexed.has(c.chainId)).map((c) => c.chainId);
  const read = new Set([...present, ...uncovered].filter((id) => all.has(id)));
  return { read, info: { via: 'multichain', found_on: present.size, probed: uncovered.length, skipped: covered.length - present.size } };
}
