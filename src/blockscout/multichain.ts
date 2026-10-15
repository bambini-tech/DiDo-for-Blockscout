/**
 * Where a wallet lives, from Blockscout's multichain aggregator, in one request
 * instead of one probe per chain. The PRO API serves the aggregator's cluster
 * routes; DiDo reads the `multichain` cluster:
 *
 *   GET /multichain/api/v1/clusters/multichain/chains            the chains it covers (cached a day)
 *   GET /multichain/api/v1/clusters/multichain/addresses/{a}     `chain_infos`: one entry per chain the address is on
 *
 * A chain the cluster does not cover is probed directly by the caller. Every
 * route here is a standard one (20 credits).
 */
import type { BlockscoutClient } from './client.js';
import { TtlCache } from '../cache.js';

export const CLUSTER = 'multichain';
const DAY = 24 * 3600_000;
const covered = new TtlCache<Set<number>>(DAY, 4);
/** A failed read is remembered briefly, so each wallet scan does not pay for the same failure. */
const RETRY_AFTER = 10 * 60_000;

let lastError: string | null = null;
let lastLookupError: string | null = null;
/** Why the last chain-list read failed, for the scan's `discovery`. */
export function aggregatorError(): string | null {
  return lastError;
}
/** Why the last address lookup failed, for the scan's `discovery`. */
export function lookupError(): string | null {
  return lastLookupError;
}

/** Chain ids the cluster covers; null when they could not be read. */
export async function aggregatorChains(client: BlockscoutClient): Promise<Set<number> | null> {
  const hit = covered.get(client.baseUrl);
  if (hit) return hit.size ? hit : null;
  const { data, status, detail } = await client.multichain<{ items?: Array<{ id?: string | number }> }>(`clusters/${CLUSTER}/chains`);
  const ids = status === 'ok' && Array.isArray(data?.items)
    ? new Set(data.items.map((c) => Number(c.id)).filter((n) => Number.isFinite(n)))
    : new Set<number>();
  lastError = ids.size ? null : status === 'ok' ? 'no chains in the answer' : detail ?? status;
  covered.set(client.baseUrl, ids, ids.size ? DAY : RETRY_AFTER);
  return ids.size ? ids : null;
}

/**
 * The chains (of those asked) where the cluster knows this address; null on
 * failure. A 404 is a failure too: from the gateway it cannot be told apart
 * from a missing route, and "not found anywhere" must never skip a chain.
 */
export async function chainsWithAddress(client: BlockscoutClient, address: string, chainIds: number[]): Promise<Set<number> | null> {
  if (!chainIds.length) return new Set();
  const { data, status, detail } = await client.multichain<{ chain_infos?: Record<string, unknown> }>(`clusters/${CLUSTER}/addresses/${address}`);
  if (status !== 'ok' || !data || typeof data.chain_infos !== 'object' || data.chain_infos === null) {
    lastLookupError = status === 'ok' ? 'unreadable answer' : detail ?? status;
    return null;
  }
  lastLookupError = null;
  const asked = new Set(chainIds);
  return new Set(Object.keys(data.chain_infos).map(Number).filter((n) => asked.has(n)));
}

/** For tests: forget the cached chain list. */
export function resetAggregatorCache(): void {
  covered.clear();
  lastError = null;
  lastLookupError = null;
}
