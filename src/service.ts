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
import { getCreator, getTxBlock, getTxCount, traceFunding, traceTokenFlows, getAddressLabels, type Flow, type FundingTrace } from './blockscout/addresses.js';
import type { Status } from './blockscout/client.js';
import { labelsOf } from './labels.js';
import { readLaunch, type Launch } from './blockscout/launch.js';
import { linkHolders, sharedSenders, type LinkOptions, type LinkResult } from './clusters.js';
import { classify } from './classify.js';
import { TtlCache } from './cache.js';

export interface TokenResponse {
  chain: Pick<Chain, 'key' | 'name' | 'chainId' | 'explorer' | 'native'>;
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
  /**
   * What Blockscout says about the addresses the map names that are not
   * holders (holders carry their own name and tags): the deployer and the
   * funders of the drawn clusters.
   */
  labels: Record<string, { name: string | null; tags: string[]; isContract: boolean }>;
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
  /** How long the map waits for the token reads once the native traces are done. */
  tokenGraceMs?: number;
  /** How long the map waits for the launch read once the traces are done. */
  launchGraceMs?: number;
  /** Oldest transactions read per trace. Blockscout bills per request, not per row: a deep window is free. */
  traceWindow?: number;
  link?: Partial<LinkOptions>;
}

const MINUTE = 60_000;
/** Token movements read per holder: the first ones are who sent it the supply. */
const TOKEN_WINDOW = 30;
const DAY = 24 * 60 * MINUTE;

export class Service {
  private readonly tokens: TtlCache<TokenResponse>;
  private readonly clusterCache: TtlCache<ClusterResponse>;
  private readonly traces: TtlCache<FundingTrace>;
  private readonly tokenTraces: TtlCache<{ status: Status; flows: Flow[]; error?: string }>;
  private readonly txCounts = new TtlCache<number>(6 * 60 * MINUTE, 20_000);
  private readonly creators = new TtlCache<{ creator: string | null; creationTx: string | null }>(24 * 60 * MINUTE, 5_000);
  private readonly launches = new TtlCache<Launch>(24 * 60 * MINUTE, 5_000);
  private readonly addressLabels = new TtlCache<{ name: string | null; tags: string[]; isContract: boolean }>(24 * 60 * MINUTE, 20_000);
  private readonly progressOf = new Map<string, Progress>();
  private readonly inflight = new Map<string, Promise<Reply<unknown>>>();
  private readonly traceLimit: number;
  private readonly concurrency: number;
  private readonly traceWindow: number;
  private readonly launchGraceMs: number;
  private readonly tokenGraceMs: number;

  constructor(private readonly client: BlockscoutClient, private readonly opts: ServiceOptions = {}) {
    this.tokens = new TtlCache(opts.tokenTtlMs ?? MINUTE);
    this.clusterCache = new TtlCache(opts.clusterTtlMs ?? 10 * MINUTE);
    this.traces = new TtlCache(opts.traceTtlMs ?? 30 * MINUTE, 50_000);
    this.tokenTraces = new TtlCache(opts.traceTtlMs ?? 30 * MINUTE, 50_000);
    this.traceLimit = opts.traceLimit ?? 50;
    this.concurrency = opts.concurrency ?? 6;
    this.traceWindow = opts.traceWindow ?? 100;
    this.launchGraceMs = opts.launchGraceMs ?? 3_000;
    this.tokenGraceMs = opts.tokenGraceMs ?? 8_000;
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
      // The token's row and its holder pages, side by side: one round trip less.
      const metaP = getTokenMeta(this.client, chain.chainId, address);
      const holdersP = getTokenHolders(this.client, chain.chainId, { address, later: metaP.then((r) => r.meta) });
      const { meta, status } = await metaP;
      if (!meta) {
        void holdersP.catch(() => undefined);
        return { kind: status === 'absent' ? 'absent' : 'error' };
      }
      const holders = await holdersP;
      if (holders.status !== 'ok') return { kind: 'error' };
      const body: TokenResponse = {
        chain: { key: chain.key, name: chain.name, chainId: chain.chainId, explorer: chain.explorer, native: chain.native },
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
    // Who a sender is (activity, contract or not) is read the moment it has
    // paid two holders, while the other traces are still running: the
    // linking step then finds it ready instead of starting another round.
    const holderSet0 = new Set(tok.body.holders.map((h) => h.address));
    const senderJobs = new Map<string, Promise<{ count: number | null; who: Awaited<ReturnType<Service['labelOf']>> }>>();
    const senderOf = (s: string) => {
      let job = senderJobs.get(s);
      if (!job) {
        job = Promise.all([this.txCount(chain, s), this.labelOf(chain, s)]).then(([count, who]) => ({ count, who }));
        senderJobs.set(s, job);
      }
      return job;
    };
    // The deployer's label, read as soon as the deployer is known.
    void deployerP.then((d) => (d.address && !holderSet0.has(d.address) ? this.labelOf(chain, d.address) : null)).catch(() => null);
    const paid = new Map<string, Set<string>>();
    const sawInflow = (holder: string, sender: string) => {
      if (holderSet0.has(sender)) return;
      const set = paid.get(sender) ?? new Set<string>();
      set.add(holder);
      paid.set(sender, set);
      if (set.size === 2) void senderOf(sender);
    };
    const [deployer, { traces, tokensComplete }] = await Promise.all([deployerP, this.traceHolders(chain, address, holders, prog, sawInflow)]);
    // The launch read runs alongside the traces. The map never waits long on
    // it: past a short grace it goes out without bundles and snipers ("not
    // read yet"), the read finishes in the background and is cached, and the
    // next look has it.
    let graceTimer: NodeJS.Timeout | undefined;
    const launch = (await Promise.race([
      launchP,
      new Promise<null>((r) => { graceTimer = setTimeout(() => r(null), this.launchGraceMs); }),
    ]).finally(() => clearTimeout(graceTimer))) ?? { status: 'ok' as const, measured: false, launchBlock: null, launchTs: null, bundles: [], snipers: [], pending: true as const };
    void launchP.catch(() => undefined);
    prog.phase = 'linking';
    prog.pct = 92;

    const linkIn = holders.map((h) => {
      const { address: a, share, isContract, name, tags } = h;
      const l = labelsOf(name, tags);
      return { address: a, share, isContract, name, exchange: l.exchange, wallet: l.wallet, raw: h.raw };
    });
    const shared = sharedSenders(linkIn, traces);
    const txCounts = new Map<string, number | null>();
    // Who each shared sender is: its activity (infrastructure or not) and
    // whether it is a contract -- a payout contract (staking rewards, vesting,
    // a distributor) pays many holders and owns none of them.
    const labels: ClusterResponse['labels'] = {};
    const contractSenders = new Set<string>();
    const checkedSenders = new Set<string>();
    await mapLimit(shared, this.concurrency, async (s) => {
      const { count, who } = await senderOf(s);
      txCounts.set(s, count);
      if (!who) return;
      checkedSenders.add(s);
      labels[s] = who;
      if (who.isContract && !labelsOf(who.name, who.tags).wallet) contractSenders.add(s);
    });

    const analysis = linkHolders({
      holders: linkIn,
      creator: deployer.address,
      traces,
      txCounts,
      contractSenders,
      checkedSenders,
      tokenDecimals: tok.body.token.decimals,
      ...(this.opts.link ? { options: this.opts.link } : {}),
    });
    // Name the funders of the drawn clusters and the deployer: one cached address read each.
    const holderSet = new Set(tok.body.holders.map((h) => h.address));
    const named = new Set<string>();
    if (deployer.address) named.add(deployer.address);
    for (const c of analysis.clusters.slice(0, 5)) {
      for (const l of analysis.links) if (l.via && c.members.includes(l.b)) named.add(l.via);
    }
    await mapLimit([...named].filter((a) => !holderSet.has(a) && !labels[a]).slice(0, 12), this.concurrency, async (a) => {
      const who = await this.labelOf(chain, a);
      if (who) labels[a] = who;
    });
    const body: ClusterResponse = {
      ...tok.body,
      labels,
      deployer: { address: deployer.address, status: deployer.status },
      pools: [...pools],
      burn: [...burn],
      launch,
      analysis,
      calls: this.client.calls - callsBefore,
      fetchedAt: new Date().toISOString(),
    };
    // A result with failed traces or an unread deployer is served, never cached.
    // ... nor one with a sender we could not identify: the next visit checks it again.
    if (!body.partial && analysis.stats.failed === 0 && deployer.status !== 'error' && launch.status !== 'error' && !launch.pending && tokensComplete && checkedSenders.size === shared.length) {
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

  /**
   * Native traces and token movements for the traced holders, in two pools.
   *
   * They are not paired per holder: a token-filtered history (`tokentx`) is a
   * slow query on Blockscout (6-17 s on a busy token, ~1 s for `txlist`), and
   * pairing them made every holder wait for its slowest read. The native pool
   * sets the pace; the token pool runs wider beside it. Once the native traces
   * are in, the token reads get TOKEN_GRACE_MS more; any still running finish
   * in the background and are cached, and the map that went out without them
   * is not cached, so the next look has every token link.
   */
  private async traceHolders(
    chain: Chain, token: string, holders: Holder[], prog?: Progress,
    onInflow?: (holder: string, sender: string) => void,
  ): Promise<{ traces: Map<string, FundingTrace>; tokensComplete: boolean }> {
    // Named contracts (routers, lockers, vaults) are never linked, so never
    // traced; a contract that is a wallet (a Safe, a multisig) is.
    const targets = holders.filter((h) => !(h.isContract && h.name) || labelsOf(h.name, h.tags).wallet).slice(0, this.traceLimit);
    const native = new Map<string, FundingTrace>();
    const moves = new Map<string, { status: Status; flows: Flow[]; error?: string }>();
    if (prog) prog.funders.total = targets.length;
    const nativeAll = mapLimit(targets, this.concurrency, async (h) => {
      const key = `${chain.key}:${h.address}`;
      let t = this.traces.get(key);
      if (!t) {
        t = await traceFunding(this.client, chain.chainId, h.address, this.traceWindow);
        // A full window is the wallet's oldest history: it cannot change, so it is kept a day.
        if (t.status === 'ok') this.traces.set(key, t, t.windowFull ? DAY : undefined);
      }
      native.set(h.address, t);
      if (onInflow && t.status === 'ok') for (const f of t.flows) if (f.dir === 'in') onInflow(h.address, f.peer);
      if (prog) {
        prog.funders.done++;
        prog.pct = Math.round(5 + (85 * prog.funders.done) / Math.max(1, prog.funders.total));
      }
    });
    const tokenAll = mapLimit(targets, this.concurrency * 2, async (h) => {
      const tkey = `${chain.key}:${token}:${h.address}`;
      let m = this.tokenTraces.get(tkey);
      if (!m) {
        m = await traceTokenFlows(this.client, chain.chainId, h.address, token, TOKEN_WINDOW);
        if (m.status === 'ok') this.tokenTraces.set(tkey, m, m.flows.length >= TOKEN_WINDOW ? DAY : undefined);
      }
      moves.set(h.address, m);
      if (onInflow && m.status === 'ok') {
        const floor = BigInt(h.raw || '0') / 100n;
        for (const f of m.flows) if (f.dir === 'in' && BigInt(f.value) >= floor) onInflow(h.address, f.peer);
      }
    });
    await nativeAll;
    let timer: NodeJS.Timeout | undefined;
    const tokensComplete = await Promise.race([
      tokenAll.then(() => true),
      new Promise<boolean>((r) => { timer = setTimeout(() => r(false), this.tokenGraceMs); }),
    ]).finally(() => clearTimeout(timer));
    void tokenAll.catch(() => undefined);
    const traces = new Map<string, FundingTrace>();
    for (const h of targets) {
      const t = native.get(h.address)!;
      const m = moves.get(h.address);
      traces.set(h.address, !m ? t : m.status === 'ok' ? { ...t, tokenFlows: m.flows } : { ...t, ...(m.error ? { tokenError: m.error } : {}) });
    }
    return { traces, tokensComplete };
  }

  /** Blockscout's name, tags and contract flag for an address; cached a day; null when it could not be read. */
  private async labelOf(chain: Chain, address: string): Promise<{ name: string | null; tags: string[]; isContract: boolean } | null> {
    const key = `${chain.key}:${address}`;
    const hit = this.addressLabels.get(key);
    if (hit) return hit;
    const r = await getAddressLabels(this.client, chain.chainId, address);
    if (r.status === 'error') return null;
    const who = { name: r.name, tags: r.tags, isContract: r.isContract };
    this.addressLabels.set(key, who);
    return who;
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
