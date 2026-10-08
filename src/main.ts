import { loadConfig } from './config.js';
import { BlockscoutClient } from './blockscout/client.js';
import { buildApp } from './server.js';

const config = loadConfig();
if (!config.apiKey) {
  console.error('BLOCKSCOUT_API_KEY is not set. Get a key at https://dev.blockscout.com and see .env.example.');
  process.exit(1);
}

const client = new BlockscoutClient({ apiKey: config.apiKey, rps: config.rps });
const app = buildApp({ client, version: config.version, logger: true });

app.listen({ port: config.port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
