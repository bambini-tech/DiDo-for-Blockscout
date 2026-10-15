/**
 * The wallet scan DiDo's wallet pane reads (GET /api/wallet-scan): one
 * wallet across every chain at once (all of data/chains.json), merged into one portfolio.
 *
 *   - priced holdings (Blockscout's USD rate) sorted by value, with % of total
 *   - under $1 counted as dust, tokens without a rate counted as unpriced,
 *     tokens Blockscout flags as scam left out
 *   - a chain that could not be read is listed as failed and missing from the
 *     total, never shown as empty
 *
 * Where to look comes first, in one request: Blockscout's multichain
 * aggregator says which chains the wallet exists on, and only those are read
 * (balance, tokens, NFTs). Chains the aggregator does not index are probed
 * directly, as before; if the aggregator cannot be read, every chain is
 * probed. Either way no chain the wallet is on is skipped for want of an
 * answer. `discovery` in the result says which way it went.
 *
 * Cost basis (PnL) is not computed in this edition: `pnl` is null and the
 * pane says so.
 */
import { CHAINS, type Chain } from './chains.js';
import type { BlockscoutClient } from './blockscout/client.js';
import { readWalletChain, type WalletChainRead } from './blockscout/wallet.js';
import { aggregatorChains, chainsWithAddress } from './blockscout/multichain.js';

const DUST_USD = 1;
const MAX_ROWS = 50;

export type Discovery = 'multichain' | 'probe';

export async function scanWallet(client: BlockscoutClient, wallet: string, chains: readonly Chain[] = CHAINS, discovery: Discovery = 'multichain') {
  const address = wallet.toLowerCase();
  const plan = await planChains(client, address, chains, discovery);
  const skipped: WalletChainRead = { status: 'absent', address: null, txCount: null, tokens: [], tokensOk: true, nfts: [], nftsMore: false };
  const reads = await Promise.all(chains.map(async (c) =>
    [c, plan.read.has(c.chainId) ? await readWalletChain(client, c.chainId, address) : skipped] as const));
  // Chains sharing a gas coin share its price: one ETH price serves an ETH chain whose row lacks it.
  const nativeUsd = new Map<string, number>();
  for (const [c, r] of reads) if (r.address?.nativeUsd && !nativeUsd.has(c.native)) nativeUsd.set(c.native, r.address.nativeUsd);

  const chainsOut = [];
  const empty: string[] = [];
  const failed: string[] = [];
  const all: Row[] = [];
  let dust = 0, dustUsd = 0, unpriced = 0;
  const nfts: Array<Record<string, unknown>> = [];
  let nftsMore = false;

  for (const [c, r] of reads) {
    const key = c.key;
    if (r.status === 'error') { failed.push(key); continue; }
    if (!r.address || (r.address.coinWei === 0n && !r.tokens.length && !r.nfts.length)) { empty.push(key); continue; }
    const rows = chainRows(c, r, nativeUsd.get(c.native) ?? null);
    const priced = rows.filter((h) => h.usd !== null && h.usd >= DUST_USD);
    const chainDust = rows.filter((h) => h.usd !== null && h.usd < DUST_USD);
    const chainUnpriced = rows.filter((h) => h.usd === null && !h.native).length;
    dust += chainDust.length;
    dustUsd += chainDust.reduce((s, h) => s + (h.usd ?? 0), 0);
    unpriced += chainUnpriced;
    const tokensUsd = priced.filter((h) => !h.native).reduce((s, h) => s + (h.usd ?? 0), 0);
    const nativeRow = rows.find((h) => h.native);
    const chainNfts = r.nfts.map((n) => ({ chain: key, chain_label: c.label, ...n }));
    nfts.push(...chainNfts);
    nftsMore ||= r.nftsMore;
    all.push(...priced);
    chainsOut.push({
      chain: key,
      chain_name: c.name,
      chain_label: c.label,
      native_symbol: c.native,
      is_contract: r.address.isContract,
      name: r.address.name,
      ens: r.address.ens,
      tags: r.address.tags,
      tx_count: r.txCount,
      native: { amount: nativeRow?.amount ?? 0, price_usd: nativeRow?.price_usd ?? null, usd: nativeRow?.usd ?? null },
      holdings: priced.sort(byUsd).slice(0, MAX_ROWS),
      unpriced: chainUnpriced,
      tokens_usd: tokensUsd,
      total_usd: tokensUsd + (nativeRow?.usd ?? 0),
      pnl: null,
      nfts: chainNfts,
      nfts_more: r.nftsMore,
      nfts_hidden: 0,
      notes: r.tokensOk ? [] : ['token balances could not be read on this chain'],
    });
  }

  chainsOut.sort((a, b) => b.total_usd - a.total_usd);
  const total = all.reduce((s, h) => s + (h.usd ?? 0), 0);
  const sorted = all.sort(byUsd);
  const shown = sorted.slice(0, MAX_ROWS).map((h) => ({ ...h, pct: total > 0 ? ((h.usd ?? 0) / total) * 100 : 0 }));
  const rest = sorted.slice(MAX_ROWS);
  const first = chainsOut[0];

  return {
    address,
    ens: chainsOut.find((c) => c.ens)?.ens ?? null,
    name: first?.name ?? null,
    tags: [...new Set(chainsOut.flatMap((c) => c.tags))],
    is_contract: chainsOut.some((c) => c.is_contract),
    tx_count: chainsOut.reduce<number | null>((s, c) => (c.tx_count === null ? s : (s ?? 0) + c.tx_count), null),
    total_usd: total,
    tokens_usd: chainsOut.reduce((s, c) => s + c.tokens_usd, 0),
    native_usd: sorted.filter((h) => h.native).reduce((s, h) => s + (h.usd ?? 0), 0),
    chains: chainsOut,
    empty_chains: empty,
    failed_chains: failed,
    holdings: shown,
    dust,
    dust_usd: dustUsd,
    more: rest.length,
    more_usd: rest.reduce((s, h) => s + (h.usd ?? 0), 0),
    unpriced,
    pnl: null,
    nfts,
    nft_count: nfts.length,
    nft_collections: new Set(nfts.map((n) => `${n.chain}:${n.collection_address}`)).size,
    nfts_more: nftsMore,
    nfts_hidden: 0,
    notes: [],
    error: null,
    pnl_pending: false,
    source: 'blockscout',
    discovery: plan.info,
  };
}

/** Which chains to read: the ones the aggregator places the wallet on, plus every chain it does not index. */
async function planChains(client: BlockscoutClient, address: string, chains: readonly Chain[], discovery: Discovery) {
  const all = new Set(chains.map((c) => c.chainId));
  if (discovery === 'probe') return { read: all, info: { via: 'probe' as const, probed: all.size } };
  const indexed = await aggregatorChains(client);
  if (!indexed) return { read: all, info: { via: 'probe' as const, probed: all.size, reason: 'aggregator chain list unavailable' } };
  const covered = chains.filter((c) => indexed.has(c.chainId)).map((c) => c.chainId);
  const present = await chainsWithAddress(client, address, covered);
  if (!present) return { read: all, info: { via: 'probe' as const, probed: all.size, reason: 'aggregator lookup failed' } };
  const uncovered = chains.filter((c) => !indexed.has(c.chainId)).map((c) => c.chainId);
  const read = new Set([...present, ...uncovered].filter((id) => all.has(id)));
  return { read, info: { via: 'multichain' as const, found_on: present.size, probed: uncovered.length, skipped: covered.length - present.size } };
}

interface Row {
  address: string;
  symbol: string;
  name: string | null;
  amount: number;
  holders: string | null;
  price_usd: number | null;
  price_source: 'blockscout' | null;
  logo: string | null;
  usd: number | null;
  pnl: null;
  native: boolean;
  chain: string;
  chain_label: string;
}

function chainRows(c: Chain, r: WalletChainRead, sharedNativeUsd: number | null): Row[] {
  const key = c.key;
  const label = c.label;
  const rows: Row[] = [];
  const coin = scale(r.address!.coinWei.toString(), 18);
  if (coin > 0) {
    const px = r.address!.nativeUsd ?? sharedNativeUsd;
    rows.push({ address: 'native', symbol: c.native, name: c.native === 'ETH' ? 'Ether' : c.native, amount: coin, holders: null, price_usd: px, price_source: px ? 'blockscout' : null,
      logo: null, usd: px ? coin * px : null, pnl: null, native: true, chain: key, chain_label: label });
  }
  for (const t of r.tokens) {
    if (t.scam) continue;
    const amount = scale(t.raw, t.decimals);
    if (amount <= 0) continue;
    rows.push({ address: t.address, symbol: t.symbol ?? '?', name: t.name, amount, holders: t.holders, price_usd: t.priceUsd,
      price_source: t.priceUsd ? 'blockscout' : null, logo: t.logo, usd: t.priceUsd ? amount * t.priceUsd : null, pnl: null,
      native: false, chain: key, chain_label: label });
  }
  return rows;
}

const byUsd = (a: Row, b: Row) => (b.usd ?? 0) - (a.usd ?? 0);

function scale(raw: string, decimals: number): number {
  if (decimals <= 0) return Number(raw);
  const s = raw.padStart(decimals + 1, '0');
  return Number(`${s.slice(0, -decimals)}.${s.slice(-decimals)}`);
}
