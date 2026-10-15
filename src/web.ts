/**
 * The DiDo page: dist/web/ (built by web/build.mjs) under a strict
 * Content-Security-Policy, plus the two small endpoints the page reads first.
 *
 * Nothing in the page is inline, so 'self' is enough for scripts and styles.
 * connect-src names this server and the two public market-data APIs the
 * browser reads prices and candles from; every holder, cluster and wallet fact
 * comes from this server, which reads Blockscout. The page is never framed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://cdn.dexscreener.com https://dd.dexscreener.com",
  "connect-src 'self' https://api.dexscreener.com https://api.geckoterminal.com",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

interface StaticFile {
  body: Buffer;
  etag: string;
  type: string;
}

export interface WebOptions {
  /** Directory holding the built page. */
  dir: string;
  version: string;
  /** Whether a Blockscout key is configured: no key, no map (the chart still runs). */
  holderIntel: boolean;
}

export function registerWeb(app: FastifyInstance, opts: WebOptions): { built: boolean } {
  const files = new Map<string, StaticFile>();
  if (existsSync(join(opts.dir, 'index.html'))) {
    for (const name of readdirSync(opts.dir)) {
      const p = join(opts.dir, name);
      if (!statSync(p).isFile()) continue;
      const body = readFileSync(p);
      files.set(name, {
        body,
        etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`,
        type: TYPES[extname(name)] ?? 'application/octet-stream',
      });
    }
  }
  let manifest: { version?: string; engine_version?: string } = {};
  try {
    manifest = JSON.parse(files.get('manifest.json')?.body.toString('utf8') ?? '{}');
  } catch {
    manifest = {};
  }

  const features = () => ({ holder_intel: opts.holderIntel, wallet_scan: opts.holderIntel });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  app.get('/api/config', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { ok: true, ...features(), version: opts.version, engine_version: manifest.engine_version ?? null };
  });
  app.get('/api/features', async () => ({ ok: true, error: null, data: features() }));
  app.get('/version', async (_req, reply) => serve(reply, 'manifest.json', { 'Cache-Control': 'no-cache' }));

  const page = async (req: FastifyRequest, reply: FastifyReply) =>
    serve(reply, 'index.html', { 'Content-Security-Policy': PAGE_CSP, 'Cache-Control': 'public, max-age=60, must-revalidate' }, req);
  // Every place is a URL handled in the browser, so these paths all serve the page.
  app.get('/', page);
  app.get('/index.html', page);
  app.get('/t', page);
  app.get('/t/*', page);
  for (const name of ['dido.js', 'dido.css']) {
    app.get(`/${name}`, async (req, reply) => {
      const versioned = (req.query as Record<string, string>).v === manifest.version;
      return serve(reply, name, { 'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300, must-revalidate' }, req);
    });
  }

  function serve(reply: FastifyReply, name: string, headers: Record<string, string>, req?: FastifyRequest) {
    const f = files.get(name);
    if (!f) return reply.code(503).type('text/plain; charset=utf-8').send('the page is not built: run `npm run build`');
    reply.headers({ ...headers, 'Content-Type': f.type, ETag: f.etag });
    if (req && req.headers['if-none-match'] === f.etag) return reply.code(304).send();
    return reply.send(f.body);
  }

  return { built: files.size > 0 };
}
