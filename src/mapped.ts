/**
 * "Mapped here": the tokens this server mapped most in the last 24 hours, for
 * the home page's shelf (GET /api/most-scanned). Counts only, in memory; the
 * price is Blockscout's at the first map, so the page can show the move since.
 */
import type { Chain } from './chains.js';

interface Entry {
  chain: string;
  address: string;
  symbol: string | null;
  name: string | null;
  hits: number[];
  first_price_usd: number | null;
}

export class MappedLog {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly windowMs = 24 * 3600_000, private readonly now: () => number = Date.now) {}

  record(chain: Chain, address: string, symbol: string | null, name: string | null, priceUsd: number | null): void {
    const key = `${chain.key}:${address}`;
    const t = this.now();
    let e = this.entries.get(key);
    if (!e) {
      if (this.entries.size >= 2_000) this.prune();
      e = { chain: chain.key, address, symbol, name, hits: [], first_price_usd: priceUsd };
      this.entries.set(key, e);
    }
    e.hits.push(t);
  }

  top(n = 20) {
    this.prune();
    return [...this.entries.values()]
      .map((e) => ({
        chain: e.chain, address: e.address, symbol: e.symbol, name: e.name,
        groups: e.hits.length,
        first_at: Math.floor(e.hits[0]! / 1000),
        last_at: Math.floor(e.hits[e.hits.length - 1]! / 1000),
        first_price_usd: e.first_price_usd,
      }))
      .sort((a, b) => b.groups - a.groups || b.last_at - a.last_at)
      .slice(0, n);
  }

  private prune(): void {
    const cut = this.now() - this.windowMs;
    for (const [k, e] of this.entries) {
      e.hits = e.hits.filter((h) => h > cut);
      if (!e.hits.length) this.entries.delete(k);
    }
  }
}
