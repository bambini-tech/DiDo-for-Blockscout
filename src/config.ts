import { readFileSync } from 'node:fs';

export interface Config {
  apiKey: string;
  port: number;
  rps: number;
  version: string;
}

function readVersion(): string {
  try {
    return readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rps = Number(env.BLOCKSCOUT_RPS ?? 4.5);
  return {
    apiKey: (env.BLOCKSCOUT_API_KEY ?? '').trim(),
    port: Number(env.PORT ?? 3000),
    rps: Number.isFinite(rps) && rps > 0 ? rps : 4.5,
    version: readVersion(),
  };
}
