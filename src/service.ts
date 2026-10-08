/**
 * The two reads the API serves, with their caches.
 *
 *   token(chain, address)     token row + top holders            (3 calls)
 *   clusters(chain, address)  the above + deployer + one funding trace per
 *                             holder + a tx count per shared sender
 *
 * Funding traces read a wallet's OLDEST history, which rarely changes, so they
 * are cached per wallet and shared across tokens: the second token a wallet
 * holds costs nothing to trace.
 */
import type { Chain } from './chains.js';
import type { BlockscoutClient } from './blockscout/client.js';
import { getTokenHolders, getTokenMeta, type Holder, type TokenMeta } from './blockscout/tokens.js';
import { getCreator, getTxCount, traceFunding, type FundingTrace } from './blockscout/addresses.js';
import { linkHolders, sharedSenders, type LinkOptions, type LinkResult } from './clusters.js';
import { TtlCache } from './cache.js';

export interface TokenResponse {
  chain: Pick<Chain, 'key' | 'name' | 'chainId' | 'explorer'>;
  token: TokenMeta;
  holders: Holder[];
  partial: boolean;
  fetchedAt: string;
}

export interface ClusterResponse extends TokenResponse {
  deployer: { address: string | null; status: 'ok' | 'absent' | 'error' };
  analysis: LinkResult;
  /** Blockscout requests this analysis cost (cache hits are free). */
  calls: number;
}

export type Reply<T> = { kind: 'ok'; body: T } | { kind: 'absent' } | { kind: 'error' };

export interface ServiceOptions {
  /** Holders traced per token, largest first. */
  traceLimit?: number;
  /** Concurrent traces; the client's rate gate is the real ceiling. */
  concurrency?: number;
  tokenTtlMs?: number;
  clusterTtlMs?: number;
  traceTtlMs?: number;
  link?: Partial<LinkOptions>;
}

const MINUTE = 60_000;

export class Service {
  private readonly tokens: TtlCache<TokenResponse>;
  private readonly clusterCache: TtlCache<ClusterResponse>;
  private readonly traces: TtlCache<FundingTrace>;
  private readonly txCounts = new TtlCache<number>(6 * 60 * MINUTE, 20_000);
  private readonly creators = new TtlCache<string | null>(24 * 60 * MINUTE, 5_000);
  private readonly inflight = new Map<string, Promise<Reply<unknown>>>();
  private readonly traceLimit: number;
  private readonly concurrency: number;

  constructor(private readonly client: BlockscoutClient, private readonly opts: ServiceOptions = {}) {
    this.tokens = new TtlCache(opts.tokenTtlMs ?? MINUTE);
    this.clusterCache = new TtlCache(opts.clusterTtlMs ?? 10 * MINUTE);
    this.traces = new TtlCache(opts.traceTtlMs ?? 30 * MINUTE, 50_000);
    this.traceLimit = opts.traceLimit ?? 50;
    this.concurrency = opts.concurrency ?? 6;
  }

  cachedToken(chain: Chain, address: string): TokenResponse | undefined {
    return this.tokens.get(`${chain.key}:${address}`);
  }

  cachedClusters(chain: Chain, address: string): ClusterResponse | undefined {
    return this.clusterCache.get(`${chain.key}:${address}`);
  }

  token(chain: Chain, address: string): Promise<Reply<TokenResponse>> {
    return this.once(`token:${chain.key}:${address}`, async () => {
      const hit = this.cachedToken(chain, address);
      if (hit) return { kind: 'ok', body: hit };
      const { meta, status } = await getTokenMeta(this.client, chain.chainId, address);
      if (!meta) return { kind: status === 'absent' ? 'absent' : 'error' };
      const holders = await getTokenHolders(this.client, chain.chainId, meta);
      if (holders.status !== 'ok') return { kind: 'error' };
      const body: TokenResponse = {
        chain: { key: chain.key, name: chain.name, chainId: chain.chainId, explorer: chain.explorer },
        token: meta,
        holders: holders.holders,
        partial: holders.partial,
        fetchedAt: new Date().toISOString(),
      };
      if (!body.partial) this.tokens.set(`${chain.key}:${address}`, body);
      return { kind: 'ok', body };
    });
  }

  clusters(chain: Chain, address: string): Promise<Reply<ClusterResponse>> {
    return this.once(`clusters:${chain.key}:${address}`, async () => {
      const hit = this.cachedClusters(chain, address);
      if (hit) return { kind: 'ok', body: hit };
      const callsBefore = this.client.calls;
      const tok = await this.token(chain, address);
      if (tok.kind !== 'ok') return tok;
      const { holders } = tok.body;

      const [deployer, traces] = await Promise.all([
        this.creator(chain, address),
        this.traceHolders(chain, holders),
      ]);

      const linkIn = holders.map(({ address: a, share, isContract, name }) => ({ address: a, share, isContract, name }));
      const shared = sharedSenders(linkIn, traces);
      const txCounts = new Map<string, number | null>();
      await mapLimit(shared, this.concurrency, async (s) => {
        txCounts.set(s, await this.txCount(chain, s));
      });

      const analysis = linkHolders({
        holders: linkIn,
        creator: deployer.address,
        traces,
        txCounts,
        ...(this.opts.link ? { options: this.opts.link } : {}),
      });
      const body: ClusterResponse = {
        ...tok.body,
        deployer,
        analysis,
        calls: this.client.calls - callsBefore,
        fetchedAt: new Date().toISOString(),
      };
      // A result with failed traces or an unread deployer is served, never cached.
      if (!body.partial && analysis.stats.failed === 0 && deployer.status !== 'error') {
        this.clusterCache.set(`${chain.key}:${address}`, body);
      }
      return { kind: 'ok', body };
    });
  }

  private async creator(chain: Chain, token: string): Promise<ClusterResponse['deployer']> {
    const key = `${chain.key}:${token}`;
    const hit = this.creators.get(key);
    if (hit !== undefined) return { address: hit, status: 'ok' };
    const { creator, status } = await getCreator(this.client, chain.chainId, token);
    if (status === 'ok') this.creators.set(key, creator);
    return { address: creator, status };
  }

  private async traceHolders(chain: Chain, holders: Holder[]): Promise<Map<string, FundingTrace>> {
    // Named contracts (pools, routers, lockers) are never linked, so never traced.
    const targets = holders.filter((h) => !(h.isContract && h.name)).slice(0, this.traceLimit);
    const out = new Map<string, FundingTrace>();
    await mapLimit(targets, this.concurrency, async (h) => {
      const key = `${chain.key}:${h.address}`;
      let t = this.traces.get(key);
      if (!t) {
        t = await traceFunding(this.client, chain.chainId, h.address);
        if (t.status === 'ok') this.traces.set(key, t);
      }
      out.set(h.address, t);
    });
    return out;
  }

  private async txCount(chain: Chain, address: string): Promise<number | null> {
    const key = `${chain.key}:${address}`;
    const hit = this.txCounts.get(key);
    if (hit !== undefined) return hit;
    const { count } = await getTxCount(this.client, chain.chainId, address);
    if (count !== null) this.txCounts.set(key, count);
    return count;
  }

  /** One walk per key at a time: concurrent callers share it. */
  private once<T>(key: string, fn: () => Promise<Reply<T>>): Promise<Reply<T>> {
    let job = this.inflight.get(key) as Promise<Reply<T>> | undefined;
    if (!job) {
      job = fn().finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    return job;
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
