import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { CHAINS, chainByKey, type Chain } from './chains.js';
import type { BlockscoutClient } from './blockscout/client.js';
import { Service, type Reply, type ServiceOptions } from './service.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface AppOptions {
  client: BlockscoutClient;
  version: string;
  service?: ServiceOptions;
  logger?: boolean;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const service = new Service(opts.client, opts.service);

  app.get('/health', async () => ({ ok: true, version: opts.version }));

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
