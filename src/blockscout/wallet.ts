/**
 * One wallet on one chain, from Blockscout's REST v2:
 *
 *   /addresses/{a}                 native balance (wei), native USD rate, name, ENS, contract flag
 *   /addresses/{a}/counters        lifetime transaction count
 *   /addresses/{a}/token-balances  every ERC-20 it holds, each with Blockscout's USD rate
 *   /addresses/{a}/nft             its NFTs (first page)
 *
 * The probe says whether the chain knows the wallet at all, and through
 * `has_tokens` (an EXISTS over its token-balance rows) whether it holds any
 * token: only then are token balances and NFTs read, and a wallet with no
 * coin and no tokens on a chain costs that one request there. A probe that
 * failed is "could not look", never "holds nothing".
 *
 * The cost basis reads the wallet's own history (readHistory): its plain
 * transactions, internal transactions and ERC-20 transfers, oldest first, in
 * one request each at Blockscout's 10,000-row window.
 */
import type { BlockscoutClient, Status } from './client.js';

export interface WalletChainRead {
  status: Status;
  address: {
    coinWei: bigint;
    nativeUsd: number | null;
    isContract: boolean;
    name: string | null;
    ens: string | null;
    tags: string[];
  } | null;
  txCount: number | null;
  tokens: Array<{
    address: string;
    symbol: string | null;
    name: string | null;
    decimals: number;
    raw: string;
    priceUsd: number | null;
    holders: string | null;
    logo: string | null;
    scam: boolean;
  }>;
  /** False when the token list could not be read (the chain total is then incomplete). */
  tokensOk: boolean;
  nfts: Array<{ collection: string | null; collection_address: string; symbol: string | null; type: string; token_id: string; name: string | null; image: string | null; amount: number; holders: number | null }>;
  nftsMore: boolean;
}

interface RawAddress {
  coin_balance?: string | null;
  exchange_rate?: string | number | null;
  is_contract?: boolean;
  has_tokens?: boolean | null;
  name?: string | null;
  ens_domain_name?: string | null;
  metadata?: { tags?: Array<{ name?: string; label?: string } | string> } | null;
  public_tags?: Array<{ display_name?: string; label?: string }> | null;
}

interface RawToken {
  address_hash?: string;
  address?: string;
  symbol?: string | null;
  name?: string | null;
  decimals?: string | null;
  exchange_rate?: string | number | null;
  holders_count?: string | null;
  holders?: string | null;
  icon_url?: string | null;
  type?: string | null;
  reputation?: string | null;
}

export async function readWalletChain(client: BlockscoutClient, chainId: number, wallet: string): Promise<WalletChainRead> {
  const empty: WalletChainRead = { status: 'ok', address: null, txCount: null, tokens: [], tokensOk: true, nfts: [], nftsMore: false };
  const probe = await client.rest<RawAddress>(chainId, `addresses/${wallet}`);
  if (probe.status !== 'ok' || !probe.data) return { ...empty, status: probe.status === 'ok' ? 'error' : probe.status };
  const a = probe.data;
  let coinWei = 0n;
  try {
    coinWei = BigInt(a.coin_balance ?? '0');
  } catch {
    coinWei = 0n;
  }
  const tags = [
    ...(a.metadata?.tags ?? []).map((t) => (typeof t === 'string' ? t : t.name ?? t.label ?? '')),
    ...(a.public_tags ?? []).map((t) => t.display_name ?? t.label ?? ''),
  ].filter(Boolean);
  const identity = {
    coinWei,
    nativeUsd: positive(a.exchange_rate),
    isContract: Boolean(a.is_contract),
    name: a.name ?? null,
    ens: a.ens_domain_name ?? null,
    tags,
  };
  // `has_tokens` false is Blockscout's own answer: no token rows at all, so
  // balances and NFTs need not be read. Absent means it did not say: read.
  const hasTokens = typeof a.has_tokens === 'boolean' ? a.has_tokens : null;
  if (hasTokens === false && coinWei === 0n) return { ...empty, address: identity };
  const none = Promise.resolve({ data: null, status: 'ok' as Status });

  const [counters, balances, nfts] = await Promise.all([
    client.rest<{ transactions_count?: string | number }>(chainId, `addresses/${wallet}/counters`),
    hasTokens === false ? none : client.rest<Array<{ token?: RawToken; value?: string }>>(chainId, `addresses/${wallet}/token-balances`),
    hasTokens === false ? none : client.rest<{ items?: RawNft[]; next_page_params?: unknown }>(chainId, `addresses/${wallet}/nft`, { type: 'ERC-721,ERC-1155' }),
  ]);

  const tokens: WalletChainRead['tokens'] = [];
  for (const row of Array.isArray(balances.data) ? balances.data : []) {
    const t = row.token;
    const address = (t?.address_hash ?? t?.address ?? '').toLowerCase();
    if (!t || !address || (t.type && t.type !== 'ERC-20')) continue;
    tokens.push({
      address,
      symbol: t.symbol ?? null,
      name: t.name ?? null,
      decimals: Number(t.decimals ?? 0) || 0,
      raw: safeBig(row.value),
      priceUsd: positive(t.exchange_rate),
      holders: t.holders_count ?? t.holders ?? null,
      logo: t.icon_url ?? null,
      scam: t.reputation === 'scam',
    });
  }

  return {
    status: 'ok',
    address: identity,
    txCount: counters.status === 'ok' && counters.data ? positiveOrZero(counters.data.transactions_count) : null,
    tokens,
    tokensOk: hasTokens === false || (balances.status === 'ok' && Array.isArray(balances.data)),
    nfts: (nfts.data?.items ?? []).map(nftRow).filter((n): n is NonNullable<ReturnType<typeof nftRow>> => n !== null),
    nftsMore: Boolean(nfts.data?.next_page_params),
  };
}

interface RawNft {
  id?: string;
  token_type?: string;
  value?: string;
  image_url?: string | null;
  metadata?: { name?: string } | null;
  token?: RawToken & { holders_count?: string };
}

function nftRow(n: RawNft) {
  const t = n.token;
  const address = t?.address_hash ?? t?.address;
  if (!t || !address || t.reputation === 'scam') return null;
  return {
    collection: t.name ?? null,
    collection_address: address,
    symbol: t.symbol ?? null,
    type: n.token_type ?? t.type ?? 'ERC-721',
    token_id: String(n.id ?? ''),
    name: n.metadata?.name ?? null,
    image: n.image_url ?? null,
    amount: Number(n.value ?? 1) || 1,
    holders: t.holders_count !== undefined && t.holders_count !== null ? Number(t.holders_count) : null,
  };
}

function positive(v: unknown): number | null {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : null;
}
function positiveOrZero(v: unknown): number | null {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : null;
}
function safeBig(v: unknown): string {
  try {
    return BigInt(String(v ?? '0').split('.')[0] || '0').toString();
  } catch {
    return '0';
  }
}

/** Blockscout's window for one Etherscan-style listing: a longer history is cut. */
export const HISTORY_ROWS = 10_000;

/** One row of txlist / txlistinternal / tokentx, as Blockscout sends it. */
export interface HistoryRow {
  hash?: string;
  transactionHash?: string;
  timeStamp?: string;
  from?: string;
  to?: string;
  value?: string;
  isError?: string;
  contractAddress?: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
}

export interface HistoryRead {
  status: Status;
  txs: HistoryRow[];
  internals: HistoryRow[];
  transfers: HistoryRow[];
  /** Which listing hit the window, if one did: its basis would be wrong, so none is given. */
  truncated: string | null;
}

/**
 * The wallet's own history on one chain, oldest first: the three listings a
 * cost basis is booked from, read side by side. Blockscout bills per request,
 * so each is one request at the full window rather than pages.
 */
export async function readHistory(client: BlockscoutClient, chainId: number, wallet: string): Promise<HistoryRead> {
  const listing = (action: string) => client.etherscan<HistoryRow[]>(chainId, {
    module: 'account', action, address: wallet, sort: 'asc', page: 1, offset: HISTORY_ROWS,
  });
  const [txs, internals, transfers] = await Promise.all([listing('txlist'), listing('txlistinternal'), listing('tokentx')]);
  const rows = (r: { data: HistoryRow[] | null }) => (Array.isArray(r.data) ? r.data : []);
  const failed = [txs, internals, transfers].some((r) => r.status === 'error');
  const named: Array<[string, HistoryRow[]]> = [['transactions', rows(txs)], ['internal transactions', rows(internals)], ['token transfers', rows(transfers)]];
  return {
    status: failed ? 'error' : 'ok',
    txs: rows(txs),
    internals: rows(internals),
    transfers: rows(transfers),
    truncated: named.find(([, r]) => r.length >= HISTORY_ROWS)?.[0] ?? null,
  };
}
