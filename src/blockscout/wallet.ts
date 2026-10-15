/**
 * One wallet on one chain, from Blockscout's REST v2:
 *
 *   /addresses/{a}                 native balance (wei), native USD rate, name, ENS, contract flag
 *   /addresses/{a}/counters        lifetime transaction count
 *   /addresses/{a}/token-balances  every ERC-20 it holds, each with Blockscout's USD rate
 *   /addresses/{a}/nft             its NFTs (first page)
 *
 * The probe says whether the chain knows the wallet at all; only then are
 * the other three read. A probe that failed is "could not look", never
 * "holds nothing".
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

  const [counters, balances, nfts] = await Promise.all([
    client.rest<{ transactions_count?: string | number }>(chainId, `addresses/${wallet}/counters`),
    client.rest<Array<{ token?: RawToken; value?: string }>>(chainId, `addresses/${wallet}/token-balances`),
    client.rest<{ items?: RawNft[]; next_page_params?: unknown }>(chainId, `addresses/${wallet}/nft`, { type: 'ERC-721,ERC-1155' }),
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
    address: {
      coinWei,
      nativeUsd: positive(a.exchange_rate),
      isContract: Boolean(a.is_contract),
      name: a.name ?? null,
      ens: a.ens_domain_name ?? null,
      tags,
    },
    txCount: counters.status === 'ok' && counters.data ? positiveOrZero(counters.data.transactions_count) : null,
    tokens,
    tokensOk: balances.status === 'ok' && Array.isArray(balances.data),
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
