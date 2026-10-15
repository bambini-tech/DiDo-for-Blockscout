/**
 * Market data for the entry board: which tokens are moving, their pools and
 * their candles. This is the one thing Blockscout does not carry, so it comes
 * from the two public market APIs the page already reads prices from:
 *
 *   DexScreener     latest boosts, top boosts, latest profiles, community
 *                   takeovers (the candidates) and pools in batches of 30
 *   GeckoTerminal   trending pools and top-volume pools per chain (more
 *                   candidates) and hourly candles for the engine
 *
 * Both are keyless and rate limited per IP, so each host has its own pacer.
 * GeckoTerminal allows about 30 requests a minute but throttles bursts, so the
 * board asks once every 4 s and backs off on a 429 (15 s, then 30 s).
 */
export const DEXSCREENER = 'https://api.dexscreener.com';
export const GECKOTERMINAL = 'https://api.geckoterminal.com/api/v2';

/** DexScreener chain id -> GeckoTerminal network id. */
export const GT_NETWORK: Record<string, string> = { ethereum: 'eth', base: 'base', arbitrum: 'arbitrum', robinhood: 'robinhood' };

export class Pacer {
  private next = 0;
  constructor(private readonly intervalMs: number, private readonly sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), private readonly now = Date.now) {}
  async wait(): Promise<void> {
    const t = this.now();
    const slot = Math.max(t, this.next);
    this.next = slot + this.intervalMs;
    if (slot > t) await this.sleep(slot - t);
  }
}

export interface MarketOptions {
  fetch?: typeof fetch;
  dsPacer?: Pacer;
  gtPacer?: Pacer;
  /** Waits after a 429, per retry (tests pass zeros). */
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

export class Market {
  readonly calls = { dexscreener: 0, gecko: 0, gecko_failed: 0 };
  private readonly fetchFn: typeof fetch;
  private readonly ds: Pacer;
  private readonly gt: Pacer;
  private readonly backoff: number[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: MarketOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
    this.ds = opts.dsPacer ?? new Pacer(1_100);
    this.gt = opts.gtPacer ?? new Pacer(4_000);
    this.backoff = opts.backoffMs ?? [15_000, 30_000];
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  private async get(url: string, host: 'ds' | 'gt'): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      await (host === 'ds' ? this.ds : this.gt).wait();
      if (host === 'ds') this.calls.dexscreener++;
      else this.calls.gecko++;
      let res: Response;
      try {
        res = await this.fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      } catch (e) {
        if (host === 'gt') this.calls.gecko_failed++;
        throw e;
      }
      if (res.status === 429 && attempt < this.backoff.length) {
        await this.sleep(this.backoff[attempt]!);
        continue;
      }
      if (!res.ok) {
        if (host === 'gt') this.calls.gecko_failed++;
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    }
  }

  /** DexScreener's candidate lists: [{ chainId, tokenAddress, via }]. */
  async dexCandidates(): Promise<Array<{ chain: string; address: string; via: string }>> {
    const lists: Array<[string, string]> = [
      ['/token-boosts/latest/v1', 'boosted'],
      ['/token-boosts/top/v1', 'boosted'],
      ['/token-profiles/latest/v1', 'profile'],
      ['/community-takeovers/latest/v1', 'takeover'],
    ];
    const out: Array<{ chain: string; address: string; via: string }> = [];
    for (const [path, via] of lists) {
      try {
        const rows = (await this.get(DEXSCREENER + path, 'ds')) as Array<{ chainId?: string; tokenAddress?: string }>;
        for (const r of Array.isArray(rows) ? rows : []) {
          if (r.chainId && r.tokenAddress) out.push({ chain: r.chainId.toLowerCase(), address: r.tokenAddress, via });
        }
      } catch {
        /* one list missing leaves the others */
      }
    }
    return out;
  }

  /** GeckoTerminal's trending and top-volume pools on one chain, as base tokens. */
  async geckoCandidates(chain: string): Promise<Array<{ chain: string; address: string; via: string }>> {
    const net = GT_NETWORK[chain];
    if (!net) return [];
    const out: Array<{ chain: string; address: string; via: string }> = [];
    for (const [path, via] of [[`/networks/${net}/trending_pools?page=1`, 'trending'], [`/networks/${net}/pools?sort=h24_volume_usd_desc&page=1`, 'top_volume']] as const) {
      try {
        const doc = (await this.get(GECKOTERMINAL + path, 'gt')) as { data?: Array<{ relationships?: { base_token?: { data?: { id?: string } } } }> };
        for (const p of doc.data ?? []) {
          const id = p.relationships?.base_token?.data?.id ?? '';
          const address = id.slice(id.indexOf('_') + 1);
          if (/^0x[0-9a-fA-F]{40}$/.test(address)) out.push({ chain, address, via });
        }
      } catch {
        /* this chain's list is missing this round */
      }
    }
    return out;
  }

  /** Pools for up to 30 tokens on one chain (DexScreener /tokens/v1). */
  async pairs(chain: string, addresses: string[]): Promise<DexPair[]> {
    const out: DexPair[] = [];
    for (let i = 0; i < addresses.length; i += 30) {
      const chunk = addresses.slice(i, i + 30);
      try {
        const rows = (await this.get(`${DEXSCREENER}/tokens/v1/${chain}/${chunk.join(',')}`, 'ds')) as DexPair[];
        if (Array.isArray(rows)) out.push(...rows);
      } catch {
        /* those tokens read as no_pair */
      }
    }
    return out;
  }

  /**
   * Hourly candles from GeckoTerminal in the engine's frame ({t,o,h,l,c,v}),
   * vetted against the pool's spot price. null = no usable candles.
   */
  async candles(pair: DexPair, aggregate: 1 | 4, limit: number): Promise<Frame | null> {
    const net = GT_NETWORK[(pair.chainId ?? '').toLowerCase()];
    const token = (pair.baseToken?.address ?? '').toLowerCase();
    if (!net || !pair.pairAddress || !token) return null;
    const url = `${GECKOTERMINAL}/networks/${net}/pools/${pair.pairAddress}/ohlcv/hour?aggregate=${aggregate}&limit=${limit}&currency=usd&token=${token}`;
    let doc: { data?: { attributes?: { ohlcv_list?: number[][] } } };
    try {
      doc = (await this.get(url, 'gt')) as typeof doc;
    } catch {
      return null;
    }
    const list = doc.data?.attributes?.ohlcv_list ?? [];
    if (!list.length) return null;
    const rows = list.slice().sort((a, b) => a[0]! - b[0]!);
    const df: Frame = {
      t: rows.map((r) => r[0]! * 1000), o: rows.map((r) => +r[1]!), h: rows.map((r) => +r[2]!),
      l: rows.map((r) => +r[3]!), c: rows.map((r) => +r[4]!), v: rows.map((r) => +r[5]!),
    };
    const last = df.c[df.c.length - 1]!;
    const spot = Number(pair.priceUsd) || 0;
    if (last > 0 && spot > 0 && (last / spot > 25 || spot / last > 25)) return null; // another asset's price
    return df;
  }
}

export interface Frame { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }

export interface DexPair {
  chainId?: string;
  pairAddress?: string;
  priceUsd?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  liquidity?: { usd?: number };
  volume?: { h1?: number; h6?: number; h24?: number };
  txns?: Record<string, { buys?: number; sells?: number }>;
  priceChange?: { h1?: number; h24?: number };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string };
  [k: string]: unknown;
}
