/**
 * Which top holders are not people: liquidity pools and burn addresses.
 *
 * Pools are drawn as one "LP" bubble, burn addresses are left out, and
 * neither is traced or linked. A pool is the pair the page trades on (the
 * caller passes it) or a contract Blockscout names like one.
 */
import type { Holder } from './blockscout/tokens.js';

const POOL_NAME = /(pool|pair|uniswap|aerodrome|velodrome|sushi|pancake|camelot|balancer|curve|algebra|slipstream|\blp\b|amm)/i;
export const BURN = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000042069420694206942069',
]);

export function isPool(h: Pick<Holder, 'address' | 'isContract' | 'name'>, pair?: string | null): boolean {
  if (pair && h.address === pair.toLowerCase()) return true;
  return h.isContract && Boolean(h.name && POOL_NAME.test(h.name));
}

export function classify(holders: Holder[], pair?: string | null): { pools: Set<string>; burn: Set<string> } {
  const pools = new Set<string>();
  const burn = new Set<string>();
  for (const h of holders) {
    if (BURN.has(h.address)) burn.add(h.address);
    else if (isPool(h, pair)) pools.add(h.address);
  }
  if (pair) pools.add(pair.toLowerCase());
  return { pools, burn };
}
