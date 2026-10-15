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
import { getCreator, getTxBlock, getTxCount, traceFunding, type FundingTrace } from './blockscout/addresses.js';
import { readLaunch, type Launch } from './blockscout/launch.js';
import { linkHolders, sharedSenders, type LinkOptions, type LinkResult } from './clusters.js';
import { classify } from './classify.js';
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
  /** Liquidity pools and burn addresses among the holders: never traced or linked. */
  pools: string[];
  burn: string[];
  launch: Launch;
  analysis: LinkResult;
  /** Blockscout requests this analysis cost (cache hits are free). */
  calls: number;
}

export type Reply<T> = { kind: 'ok'; body: T } | { kind: 'absent' } | { kind: 'error' };

/** What a cluster walk in flight has done so far, for the page's progress chip. */
export interface Progress {
  running: boolean;
  phase: 'graph' | 'funders' | 'linking';
  funders: { done: number; total: number };
  pct: number;
}

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
  private readonly creators = new TtlCache<{ creator: string | null; creationTx: string | null }>(24 * 60 * MINUTE, 5_000);
  private readonly launches = new TtlCache<Launch>(24 * 60 * MINUTE, 5_000);
  private readonly progressOf = new Map<string, Progress>();
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

  /** Blockscout requests sent so far (for the board's accounting). */
  get blockscoutCalls(): number {
    return this.client.calls;
  }

  progress(chain: Chain, address: string): Progress | { running: false } {
    return this.progressOf.get(`${chain.key}:${address}`) ?? { running: false };
  }

  clusters(chain: Chain, address: string, pair?: string | null): Promise<Reply<ClusterResponse>> {
    return this.once(`clusters:${chain.key}:${address}`, async () => {
      const hit = this.cachedClusters(chain, address);
      if (hit) return { kind: 'ok', body: hit };
      const pkey = `${chain.key}:${address}`;
      const prog: Progress = { running: true, phase: 'graph', funders: { done: 0, total: 0 }, pct: 2 };
      this.progressOf.set(pkey, prog);
      try {
        return await this.walk(chain, address, pair ?? null, prog);
      } finally {
        this.progressOf.delete(pkey);
      }
    });
  }

  private async walk(chain: Chain, address: string, pair: string | null, prog: Progress): Promise<Reply<ClusterResponse>> {
    const callsBefore = this.client.calls;
    const tok = await this.token(chain, address);
    if (tok.kind !== 'ok') return tok;
    const { pools, burn } = classify(tok.body.holders, pair);
    // Pools and burn addresses are not people: they are never traced or linked.
    const holders = tok.body.holders.filter((h) => !pools.has(h.address) && !burn.has(h.address));

    const deployerP = this.creator(chain, address);
    const launchP = deployerP.then((d) => this.launch(chain, address, d.creationTx, pools, new Set([...burn, address, ...(d.address ? [d.address] : [])])));
    prog.phase = 'funders';
    const [deployer, traces, launch] = await Promise.all([deployerP, this.traceHolders(chain, holders, prog), launchP]);
    prog.phase = 'linking';
    prog.pct = 92;

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
      deployer: { address: deployer.address, status: deployer.status },
      pools: [...pools],
      burn: [...burn],
      launch,
      analysis,
      calls: this.client.calls - callsBefore,
      fetchedAt: new Date().toISOString(),
    };
    // A result with failed traces or an unread deployer is served, never cached.
    if (!body.partial && analysis.stats.failed === 0 && deployer.status !== 'error' && launch.status !== 'error') {
      this.clusterCache.set(`${chain.key}:${address}`, body);
    }
    return { kind: 'ok', body };
  }

  private async creator(chain: Chain, token: string): Promise<ClusterResponse['deployer'] & { creationTx: string | null }> {
    const key = `${chain.key}:${token}`;
    const hit = this.creators.get(key);
    if (hit !== undefined) return { address: hit.creator, creationTx: hit.creationTx, status: 'ok' };
    const { creator, creationTx, status } = await getCreator(this.client, chain.chainId, token);
    if (status === 'ok') this.creators.set(key, { creator, creationTx });
    return { address: creator, creationTx, status };
  }

  /** Launch signals; cached for a day once measured (a launch never changes). */
  private async launch(chain: Chain, token: string, creationTx: string | null, pools: Set<string>, exclude: Set<string>): Promise<Launch> {
    const key = `${chain.key}:${token}`;
    const hit = this.launches.get(key);
    if (hit) return hit;
    const notMeasured: Launch = { status: 'ok', measured: false, launchBlock: null, launchTs: null, bundles: [], snipers: [] };
    if (!creationTx || !pools.size) return notMeasured;
    const tx = await getTxBlock(this.client, chain.chainId, creationTx);
    if (tx.status !== 'ok' || tx.block === null) return { ...notMeasured, status: tx.status === 'absent' ? 'ok' : 'error' };
    const launch = await readLaunch(this.client, chain.chainId, token, tx.block, pools, exclude);
    if (launch.measured) this.launches.set(key, launch);
    return launch;
  }

  private async traceHolders(chain: Chain, holders: Holder[], prog?: Progress): Promise<Map<string, FundingTrace>> {
    // Named contracts (routers, lockers) are never linked, so never traced.
    const targets = holders.filter((h) => !(h.isContract && h.name)).slice(0, this.traceLimit);
    const out = new Map<string, FundingTrace>();
    if (prog) prog.funders.total = targets.length;
    await mapLimit(targets, this.concurrency, async (h) => {
      const key = `${chain.key}:${h.address}`;
      let t = this.traces.get(key);
      if (!t) {
        t = await traceFunding(this.client, chain.chainId, h.address);
        if (t.status === 'ok') this.traces.set(key, t);
      }
      out.set(h.address, t);
      if (prog) {
        prog.funders.done++;
        prog.pct = Math.round(5 + (85 * prog.funders.done) / Math.max(1, prog.funders.total));
      }
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
