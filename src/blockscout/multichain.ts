/**
 * Where a wallet lives, from Blockscout's multichain aggregator, in one request
 * instead of one probe per chain.
 *
 *   GET /multichain/api/v1/chains?only_active=true       the chains it indexes (cached a day)
 *   GET /multichain/api/v1/addresses?q=<a>&chain_id=...  one row per chain the address exists on
 *
 * The aggregator refuses a request naming a chain it does not index, so only
 * indexed chains are asked about; the caller probes the rest directly. Every
 * route here is a standard one (20 credits).
 */
import type { BlockscoutClient } from './client.js';
import { TtlCache } from '../cache.js';

const DAY = 24 * 3600_000;
const indexed = new TtlCache<Set<number>>(DAY, 4);
/** A failed read is remembered briefly, so each wallet scan does not pay for the same failure. */
const RETRY_AFTER = 10 * 60_000;

/** Chain ids the aggregator indexes; null when it could not be read. */
export async function aggregatorChains(client: BlockscoutClient): Promise<Set<number> | null> {
  const hit = indexed.get(client.baseUrl);
  if (hit) return hit.size ? hit : null;
  const { data, status } = await client.multichain<{ items?: Array<{ id?: string | number }> }>('chains', { only_active: 'true' });
  const ids = status === 'ok' && Array.isArray(data?.items)
    ? new Set(data.items.map((c) => Number(c.id)).filter((n) => Number.isFinite(n)))
    : new Set<number>();
  indexed.set(client.baseUrl, ids, ids.size ? DAY : RETRY_AFTER);
  return ids.size ? ids : null;
}

/** The chains (of those asked) where the aggregator knows this address; null on failure. */
export async function chainsWithAddress(client: BlockscoutClient, address: string, chainIds: number[]): Promise<Set<number> | null> {
  if (!chainIds.length) return new Set();
  const { data, status } = await client.multichain<{ items?: Array<{ hash?: string; chain_id?: string | number }>; next_page_params?: unknown }>(
    'addresses', { q: address, chain_id: chainIds, page_size: Math.max(50, chainIds.length) });
  if (status !== 'ok' || !Array.isArray(data?.items)) return null;
  const me = address.toLowerCase();
  return new Set(data.items.filter((r) => (r.hash ?? '').toLowerCase() === me).map((r) => Number(r.chain_id)).filter((n) => Number.isFinite(n)));
}

/** For tests: forget the cached chain list. */
export function resetAggregatorCache(): void {
  indexed.clear();
}
