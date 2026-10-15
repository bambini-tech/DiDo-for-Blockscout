import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { CHAINS, chainByKey, type Chain } from './chains.js';
import type { BlockscoutClient } from './blockscout/client.js';
import { Service, type Reply, type ServiceOptions } from './service.js';
import { registerWeb } from './web.js';
import { registerIntel } from './intel-routes.js';
import { MappedLog } from './mapped.js';
import { tintOf } from './tint.js';
import { BoardKeeper } from './board/keeper.js';
import { Market } from './market/market.js';
import { loadEngine } from './board/engine.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface AppOptions {
  client: BlockscoutClient;
  version: string;
  service?: ServiceOptions;
  logger?: boolean;
  /** Serve the built DiDo page from this directory. */
  webDir?: string;
  /** False when no Blockscout key is configured: the page then shows no map. */
  holderIntel?: boolean;
  /** Uncached cluster scans per IP per minute. */
  scansPerMinute?: number;
  /** Fetch used for token logos (tests pass a stub). */
  fetchImage?: typeof fetch;
  /**
   * Proxy hops in front of the server whose X-Forwarded-For to trust (Railway: 1),
   * so per-IP limits see the visitor and not the proxy. Never `true`: that
   * would let a visitor name their own IP.
   */
  trustProxyHops?: number;
  /** Run the entry board (market reads on a 4-hour beat). Off in tests unless asked. */
  board?: boolean | { market?: Market; intervalMs?: number; firstDelayMs?: number };
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const hops = opts.trustProxyHops ?? 0;
  const app = Fastify({
    logger: opts.logger ?? false,
    // Trust the nearest `hops` addresses (i = 0 is the socket peer): the same as a hop count.
    ...(hops > 0 ? { trustProxy: (_addr: string, i: number) => i < hops } : {}),
  });
  const service = new Service(opts.client, opts.service);

  app.get('/health', async () => ({
    ok: true,
    version: opts.version,
    ...(opts.client.ledger ? { blockscout: { ...opts.client.ledger.stats(), requests: opts.client.calls } } : {}),
  }));
  if (opts.webDir) registerWeb(app, { dir: opts.webDir, version: opts.version, holderIntel: opts.holderIntel ?? true });
  const mapped = new MappedLog();
  let board: BoardKeeper | undefined;
  if (opts.board && (opts.holderIntel ?? true)) {
    const b = typeof opts.board === 'object' ? opts.board : {};
    board = new BoardKeeper(
      { market: b.market ?? new Market(), engine: loadEngine(), service, intervalMs: b.intervalMs ?? 4 * 3600_000 },
      (msg) => app.log.info(msg),
    );
    board.start(b.firstDelayMs ?? 5_000);
    app.addHook('onClose', async () => board?.stop());
  }
  registerIntel(app, service, {
    ...(board ? { board } : {}),
    client: opts.client,
    configured: opts.holderIntel ?? true,
    ...(opts.scansPerMinute !== undefined ? { scansPerMinute: opts.scansPerMinute } : {}),
    onMapped: (chain, token, symbol, name, price) => mapped.record(chain, token, symbol, name, price),
  });
  app.get('/api/token-tint', async (req, reply) => {
    const u = String((req.query as Record<string, string>).u ?? '');
    const t = await tintOf(u, opts.fetchImage);
    reply.header('Cache-Control', t ? 'public, max-age=86400' : 'no-store');
    // No colours (or a logo we will not fetch) is an answer: the page keeps its plain light.
    return { ok: true, error: null, data: t ?? { colors: [] } };
  });
  app.get('/api/most-scanned', async () => ({ ok: true, error: null, data: { window_h: 24, tokens: mapped.top() } }));

  app.get('/api/chains', async () => ({
    chains: CHAINS.map(({ key, name, chainId, explorer }) => ({ key, name, chainId, explorer })),
  }));

  type Params = { Params: { chain: string; address: string } };

  app.get<Params>('/api/token/:chain/:address', async (req, reply) => {
    const target = parse(req.params, reply);
    if (!target) return reply;
    const cached = service.cachedToken(target.chain, target.address);
    if (cached) return reply.header('x-cache', 'hit').send(cached);
    return send(reply, await service.token(target.chain, target.address), target.chain);
  });

  app.get<Params>('/api/clusters/:chain/:address', async (req, reply) => {
    const target = parse(req.params, reply);
    if (!target) return reply;
    const cached = service.cachedClusters(target.chain, target.address);
    if (cached) return reply.header('x-cache', 'hit').send(cached);
    return send(reply, await service.clusters(target.chain, target.address), target.chain);
  });

  return app;
}

function parse(p: { chain: string; address: string }, reply: FastifyReply): { chain: Chain; address: string } | null {
  const chain = chainByKey(p.chain);
  if (!chain) {
    reply.code(400).send({ error: 'unknown_chain', chains: CHAINS.map((c) => c.key) });
    return null;
  }
  if (!ADDRESS.test(p.address)) {
    reply.code(400).send({ error: 'bad_address' });
    return null;
  }
  return { chain, address: p.address.toLowerCase() };
}

function send<T>(reply: FastifyReply, result: Reply<T>, chain: Chain): FastifyReply {
  if (result.kind === 'absent') return reply.code(404).send({ error: 'token_not_found', chain: chain.key });
  if (result.kind === 'error') return reply.code(502).send({ error: 'blockscout_unavailable' });
  return reply.header('x-cache', 'miss').send(result.body);
}
