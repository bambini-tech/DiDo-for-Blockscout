import Fastify, { type FastifyInstance } from 'fastify';
import { CHAINS, chainByKey } from './chains.js';
import type { BlockscoutClient } from './blockscout/client.js';
import { getTokenHolders, getTokenMeta, type Holder, type TokenMeta } from './blockscout/tokens.js';
import { TtlCache } from './cache.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface TokenResponse {
  chain: { key: string; name: string; chainId: number; explorer: string };
  token: TokenMeta;
  holders: Holder[];
  partial: boolean;
  fetchedAt: string;
}

export interface AppOptions {
  client: BlockscoutClient;
  version: string;
  cacheTtlMs?: number;
  logger?: boolean;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const cache = new TtlCache<TokenResponse>(opts.cacheTtlMs ?? 60_000);
  // One upstream walk per token at a time: a second request for the same
  // token waits on the first instead of spending the credits again.
  const inflight = new Map<string, Promise<TokenReply>>();

  app.get('/health', async () => ({ ok: true, version: opts.version }));

  app.get('/api/chains', async () => ({
    chains: CHAINS.map(({ key, name, chainId, explorer }) => ({ key, name, chainId, explorer })),
  }));

  app.get<{ Params: { chain: string; address: string } }>('/api/token/:chain/:address', async (req, reply) => {
    const chain = chainByKey(req.params.chain);
    if (!chain) return reply.code(400).send({ error: 'unknown_chain', chains: CHAINS.map((c) => c.key) });
    if (!ADDRESS.test(req.params.address)) return reply.code(400).send({ error: 'bad_address' });
    const address = req.params.address.toLowerCase();
    const key = `${chain.key}:${address}`;

    const cached = cache.get(key);
    if (cached) return reply.header('x-cache', 'hit').send(cached);

    let job = inflight.get(key);
    if (!job) {
      job = loadToken(opts.client, chain, address).finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    const result = await job;
    if (result.kind === 'absent') return reply.code(404).send({ error: 'token_not_found', chain: chain.key });
    if (result.kind === 'error') return reply.code(502).send({ error: 'blockscout_unavailable' });
    if (!result.body.partial) cache.set(key, result.body);
    return reply.header('x-cache', 'miss').send(result.body);
  });

  return app;
}

type TokenReply =
  | { kind: 'ok'; body: TokenResponse }
  | { kind: 'absent' }
  | { kind: 'error' };

async function loadToken(
  client: BlockscoutClient,
  chain: (typeof CHAINS)[number],
  address: string,
): Promise<TokenReply> {
  const { meta, status } = await getTokenMeta(client, chain.chainId, address);
  if (!meta) return { kind: status === 'absent' ? 'absent' : 'error' };
  const holders = await getTokenHolders(client, chain.chainId, meta);
  if (holders.status !== 'ok') return { kind: 'error' };
  return {
    kind: 'ok',
    body: {
      chain: { key: chain.key, name: chain.name, chainId: chain.chainId, explorer: chain.explorer },
      token: meta,
      holders: holders.holders,
      partial: holders.partial,
      fetchedAt: new Date().toISOString(),
    },
  };
}
