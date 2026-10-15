import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { BlockscoutClient } from './blockscout/client.js';
import { buildApp } from './server.js';
import { RULES } from './board/read.js';

// Local runs read .env; on Railway the variables come from the service settings.
try {
  process.loadEnvFile();
} catch {
  /* no .env: the environment is all there is */
}

const config = loadConfig();
// Engine reads per board round (each costs two candle requests); default 60.
if (Number(process.env.BOARD_MAX_READS) > 0) RULES.maxReads = Number(process.env.BOARD_MAX_READS);
if (!config.apiKey) {
  console.warn('BLOCKSCOUT_API_KEY is not set: the page and chart run, the holder map and wallet scans do not. See .env.example.');
}

const client = new BlockscoutClient({ apiKey: config.apiKey, rps: config.rps, baseUrl: config.baseUrl });
const app = buildApp({
  client,
  version: config.version,
  logger: true,
  webDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
  holderIntel: Boolean(config.apiKey),
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 1) || 0,
  board: process.env.BOARD_ENABLED !== '0',
});

app.listen({ port: config.port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
