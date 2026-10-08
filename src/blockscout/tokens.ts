/**
 * Token reads: the token's own row and its top holders.
 *
 * Amounts arrive as raw integer strings (undivided by decimals) and can be far
 * beyond 2^53, so shares are computed in BigInt and only the display balance
 * is a float.
 */
import type { BlockscoutClient, Status } from './client.js';

export interface TokenMeta {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number;
  totalSupply: string;
  holderCount: number | null;
  iconUrl: string | null;
  type: string | null;
}

export interface Holder {
  address: string;
  /** Raw amount, undivided, as Blockscout sent it. */
  raw: string;
  /** Amount divided by decimals; for display only. */
  balance: number;
  /** Percent of total supply, 0-100 (4 decimals), or null if supply is unknown. */
  share: number | null;
  isContract: boolean;
  name: string | null;
  tags: string[];
}

interface RawToken {
  address_hash?: string;
  address?: string;
  name?: string | null;
  symbol?: string | null;
  decimals?: string | null;
  total_supply?: string | null;
  holders_count?: string | null;
  holders?: string | null;
  icon_url?: string | null;
  type?: string | null;
}

interface RawHolderPage {
  items?: Array<{
    value?: string;
    address?: {
      hash?: string;
      is_contract?: boolean;
      name?: string | null;
      metadata?: { tags?: Array<{ name?: string; label?: string } | string> } | null;
    };
  }>;
  next_page_params?: Record<string, string | number> | null;
}

export async function getTokenMeta(
  client: BlockscoutClient,
  chainId: number,
  token: string,
): Promise<{ meta: TokenMeta | null; status: Status }> {
  const { data, status } = await client.rest<RawToken>(chainId, `tokens/${token}`);
  if (status !== 'ok' || !data) return { meta: null, status: status === 'ok' ? 'error' : status };
  // Newer instances send `holders_count`; older ones `holders`.
  const hc = toInt(data.holders_count ?? data.holders);
  return {
    status: 'ok',
    meta: {
      address: (data.address_hash ?? data.address ?? token).toLowerCase(),
      name: data.name ?? null,
      symbol: data.symbol ?? null,
      decimals: toInt(data.decimals) ?? 0,
      totalSupply: toBigIntString(data.total_supply),
      holderCount: hc,
      iconUrl: data.icon_url ?? null,
      type: data.type ?? null,
    },
  };
}

/**
 * Top holders, keyset-paginated (50 per page). Stops early at the last page.
 * A failure after the first page keeps what was read and reports `partial`.
 */
export async function getTokenHolders(
  client: BlockscoutClient,
  chainId: number,
  meta: TokenMeta,
  pages = 2,
): Promise<{ holders: Holder[]; status: Status; partial: boolean }> {
  const holders: Holder[] = [];
  const supply = BigInt(meta.totalSupply || '0');
  let params: Record<string, string | number> = {};
  for (let page = 0; page < Math.max(1, pages); page++) {
    const { data, status } = await client.rest<RawHolderPage>(chainId, `tokens/${meta.address}/holders`, params);
    if (status !== 'ok' || !data) {
      if (page === 0) return { holders, status: status === 'ok' ? 'error' : status, partial: false };
      return { holders, status: 'ok', partial: true };
    }
    for (const item of data.items ?? []) {
      const hash = item.address?.hash;
      if (!hash) continue;
      const raw = toBigIntString(item.value);
      holders.push({
        address: hash.toLowerCase(),
        raw,
        balance: scale(raw, meta.decimals),
        share: supply > 0n ? Number((BigInt(raw) * 1_000_000n) / supply) / 10_000 : null,
        isContract: Boolean(item.address?.is_contract),
        name: item.address?.name ?? null,
        tags: (item.address?.metadata?.tags ?? [])
          .map((t) => (typeof t === 'string' ? t : t.name ?? t.label ?? ''))
          .filter((t): t is string => Boolean(t)),
      });
    }
    if (!data.next_page_params) break;
    params = data.next_page_params;
  }
  return { holders, status: 'ok', partial: false };
}

function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toBigIntString(v: unknown): string {
  try {
    return BigInt(String(v ?? '0').split('.')[0] || '0').toString();
  } catch {
    return '0';
  }
}

function scale(raw: string, decimals: number): number {
  if (decimals <= 0) return Number(raw);
  const s = raw.padStart(decimals + 1, '0');
  return Number(`${s.slice(0, -decimals)}.${s.slice(-decimals)}`);
}
