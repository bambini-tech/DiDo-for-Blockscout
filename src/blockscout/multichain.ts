/**
 * Where a wallet lives, from Blockscout's multichain aggregator, in one request
 * instead of one probe per chain. The PRO API serves the aggregator's cluster
 * routes; DiDo reads the `multichain` cluster:
 *
 *   GET /multichain/api/v1/clusters/multichain/chains                    the chains it covers (cached a day, 20 credits)
 *   GET /multichain/api/v1/clusters/multichain/search/addresses?q={a}    `chain_infos`: every chain the address is on (120 credits)
 *
 * One search (120 credits) replaces a probe on every chain (17 x 20). A chain
 * the cluster does not cover is still probed directly by the caller. (The
 * gateway does not serve the cheaper `clusters/{id}/addresses/{a}` route.)
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
 * Every chain the aggregator knows this address on, from one search across
 * the cluster (`chain_infos` of the matching row); null on failure. An
 * address seen nowhere is an empty answer (`items: []`), never an error.
 * The search can name chains beyond the cluster's list; those count too.
 */
export async function chainsWithAddress(client: BlockscoutClient, address: string): Promise<Set<number> | null> {
  const { data, status, detail } = await client.multichain<{ items?: Array<{ hash?: string; chain_infos?: Record<string, unknown> }> }>(
    `clusters/${CLUSTER}/search/addresses`, { q: address });
  if (status !== 'ok' || !data || !Array.isArray(data.items)) {
    lastLookupError = status === 'ok' ? 'unreadable answer' : detail ?? status;
    return null;
  }
  lastLookupError = null;
  const me = address.toLowerCase();
  const found = new Set<number>();
  for (const row of data.items) {
    if ((row.hash ?? '').toLowerCase() !== me) continue;
    for (const id of Object.keys(row.chain_infos ?? {})) if (Number.isFinite(Number(id))) found.add(Number(id));
  }
  return found;
}

/** For tests: forget the cached chain list. */
export function resetAggregatorCache(): void {
  covered.clear();
  lastError = null;
  lastLookupError = null;
}
