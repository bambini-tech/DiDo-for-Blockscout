/**
 * The endpoints DiDo's page calls, in its `{ ok, error, data }` envelope:
 *
 *   GET /api/holder-intel?token&chain[&pair][&stage=base|full]
 *   GET /api/holder-progress?token&chain
 *   GET /api/board            (no entry board in this edition: feature_disabled)
 *
 * Error codes match what the page knows how to word: invalid_token,
 * unsupported_chain, token_not_found, rate_limited, not_configured, internal.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { chainByKey, type Chain } from './chains.js';
import type { Service } from './service.js';
import { basePayload, fullPayload } from './holders.js';
import { startWalletScan, type Discovery, type WalletPricer, type WalletScan } from './wallet.js';
import type { BlockscoutClient } from './blockscout/client.js';
import { TtlCache } from './cache.js';
import type { BoardKeeper } from './board/keeper.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface IntelOptions {
  configured: boolean;
  /** Uncached full scans per IP per minute; cache hits are free. */
  scansPerMinute?: number;
  /** Uncached wallet scans per IP per minute. */
  walletScansPerMinute?: number;
  client: BlockscoutClient;
  /** How the wallet scan finds a wallet's chains: one multichain lookup (default) or a probe per chain. */
  walletDiscovery?: Discovery;
  /** Prices the tokens Blockscout has no rate for (DexScreener); null prices from Blockscout alone. */
  walletPricer?: WalletPricer | null;
  /** The entry board; absent, the page shows no board and no garden. */
  board?: BoardKeeper;
  onMapped?: (chain: Chain, token: string, symbol: string | null, name: string | null, priceUsd: number | null) => void;
}

const STATUS: Record<string, number> = {
  invalid_token: 400, unsupported_chain: 400, token_not_found: 404, rate_limited: 429, not_configured: 503, internal: 502, feature_disabled: 200, unavailable: 200,
};

export function registerIntel(app: FastifyInstance, service: Service, opts: IntelOptions): void {
  const limit = new IpLimiter(opts.scansPerMinute ?? 6, 60_000);
  const fail = (reply: FastifyReply, code: string) =>
    reply.code(STATUS[code] ?? 502).header('Cache-Control', 'no-store').send({ ok: false, error: code, data: null });
  const ok = (reply: FastifyReply, data: unknown) => reply.header('Cache-Control', 'no-store').send({ ok: true, error: null, data });

  const target = (req: FastifyRequest): { chain: Chain; token: string; pair: string | null } | string => {
    const q = req.query as Record<string, string | undefined>;
    const token = (q.token ?? '').trim();
    if (!ADDRESS.test(token)) return 'invalid_token';
    const chain = chainByKey((q.chain ?? '').trim());
    if (!chain) return 'unsupported_chain';
    const pair = q.pair && ADDRESS.test(q.pair) ? q.pair.toLowerCase() : null;
    return { chain, token: token.toLowerCase(), pair };
  };

  app.get('/api/holder-intel', async (req, reply) => {
    const t = target(req);
    if (typeof t === 'string') return fail(reply, t);
    if (!opts.configured) return fail(reply, 'not_configured');
    const stage = (req.query as Record<string, string>).stage === 'full' ? 'full' : 'base';

    if (stage === 'base') {
      const r = await service.token(t.chain, t.token);
      if (r.kind === 'absent') return fail(reply, 'token_not_found');
      if (r.kind === 'error') return fail(reply, 'internal');
      return ok(reply, basePayload(r.body, t.pair));
    }

    if (!service.cachedClusters(t.chain, t.token) && !limit.take(req.ip)) return fail(reply, 'rate_limited');
    const r = await service.clusters(t.chain, t.token, t.pair);
    if (r.kind === 'absent') return fail(reply, 'token_not_found');
    if (r.kind === 'error') return fail(reply, 'internal');
    const meta = r.body.token;
    opts.onMapped?.(t.chain, t.token, meta.symbol, meta.name, meta.priceUsd);
    return ok(reply, fullPayload(r.body, t.pair));
  });

  app.get('/api/holder-progress', async (req, reply) => {
    const t = target(req);
    if (typeof t === 'string') return fail(reply, t);
    return ok(reply, service.progress(t.chain, t.token));
  });

  // The page reads 'feature_disabled' / 'unavailable' as "no board to show": no shelf, no garden.
  app.get('/api/board', async (_req, reply) => {
    if (!opts.board) return fail(reply, 'feature_disabled');
    if (!opts.board.doc) return fail(reply, 'unavailable');
    return ok(reply, opts.board.doc);
  });

  // The wallet journey: one wallet across every chain. `defer=1` answers as
  // soon as balances, prices and NFTs are in (`pnl_pending`), while the cost
  // basis books; /pnl then hands over the finished scan. /pnl never starts a
  // read of its own, so it needs no rate limit: with nothing to hand over it
  // answers `not_pending` and the page asks for the full scan.
  const walletLimit = new IpLimiter(opts.walletScansPerMinute ?? 10, 60_000);
  const wallets = new TtlCache<WalletScan>(2 * 60_000, 500);
  // Every finished scan, for /pnl to hand over: a card's basis must not cost a second scan.
  const handoff = new TtlCache<WalletScan>(2 * 60_000, 500);
  const scans = new Map<string, Promise<{ card: WalletScan; finished: Promise<WalletScan> | null }>>();
  const PNL_WAIT_MS = 55_000;
  const allFailed = (d: WalletScan) => d.failed_chains.length > 0 && !d.chains.length && !d.empty_chains.length;
  const sendScan = (reply: FastifyReply, d: WalletScan) => (allFailed(d)
    ? reply.code(502).header('Cache-Control', 'no-store').send({ ok: false, error: 'internal', detail: 'Blockscout could not be read on any chain right now.', data: null })
    : ok(reply, d));
  const start = (address: string) => {
    const job = startWalletScan(opts.client, address, undefined, opts.walletDiscovery ?? 'multichain', { pricer: opts.walletPricer ?? null });
    scans.set(address, job);
    void job.then(({ card, finished }) => (finished ?? Promise.resolve(card)).then((full) => {
      handoff.set(address, full);
      // A scan with a chain that could not be read is not kept: the next visit reads again.
      if (!full.failed_chains.length) wallets.set(address, full);
    })).catch(() => undefined).finally(() => scans.delete(address));
    return job;
  };

  app.get('/api/wallet-scan', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const address = String(q.address ?? '').trim().toLowerCase();
    if (!ADDRESS.test(address)) return reply.code(400).send({ ok: false, error: 'invalid_address', detail: 'that is not an EVM address.', data: null });
    if (!opts.configured) return fail(reply, 'not_configured');
    const hit = wallets.get(address);
    if (hit) return ok(reply, hit);
    let job = scans.get(address);
    if (!job) {
      if (!walletLimit.take(req.ip)) return fail(reply, 'rate_limited');
      job = start(address);
    }
    const { card, finished } = await job;
    if (q.defer === '1' || q.defer === 'true' || !finished) return sendScan(reply, card);
    return sendScan(reply, await finished);
  });

  app.get('/api/wallet-scan/pnl', async (req, reply) => {
    const address = String((req.query as Record<string, string>).address ?? '').trim().toLowerCase();
    if (!ADDRESS.test(address)) return reply.code(400).send({ ok: false, error: 'invalid_address', detail: 'that is not an EVM address.', data: null });
    const job = scans.get(address);
    if (job) {
      const { card, finished } = await job;
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), PNL_WAIT_MS); });
      const full = await Promise.race([finished ?? Promise.resolve(card), late]).finally(() => clearTimeout(timer));
      return full ? sendScan(reply, full) : reply.code(504).header('Cache-Control', 'no-store').send({ ok: false, error: 'timeout', data: null });
    }
    const hit = wallets.get(address) ?? handoff.get(address);
    if (hit) return sendScan(reply, hit);
    return reply.code(404).header('Cache-Control', 'no-store').send({ ok: false, error: 'not_pending', data: null });
  });
}

/** A fixed-window counter per IP. */
export class IpLimiter {
  private readonly hits = new Map<string, { n: number; reset: number }>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  take(ip: string): boolean {
    const t = this.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
    const h = this.hits.get(ip);
    if (!h || h.reset <= t) {
      this.hits.set(ip, { n: 1, reset: t + this.windowMs });
      return true;
    }
    if (h.n >= this.max) return false;
    h.n++;
    return true;
  }
}
