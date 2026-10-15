import { readFileSync } from 'node:fs';
import { planNamed, type Plan } from './blockscout/credits.js';

export interface Config {
  apiKey: string;
  port: number;
  rps: number;
  version: string;
  /** Blockscout PRO API base; override only to test against a stand-in. */
  baseUrl: string;
  /** The Blockscout plan the key is on (BLOCKSCOUT_PLAN: builder, the default, or free). */
  plan: Plan;
}

function readVersion(): string {
  try {
    return readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const base = planNamed(env.BLOCKSCOUT_PLAN);
  // Any knob set on its own wins over the plan's default.
  const num = (v: string | undefined, d: number) => (v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const plan: Plan = {
    ...base,
    rps: num(env.BLOCKSCOUT_RPS, base.rps) || base.rps,
    dailyBrake: num(env.BLOCKSCOUT_DAILY_CREDIT_BRAKE, base.dailyBrake),
  };
  return {
    apiKey: (env.BLOCKSCOUT_API_KEY ?? '').trim(),
    port: Number(env.PORT ?? 3000),
    rps: plan.rps,
    plan,
    version: readVersion(),
    baseUrl: (env.BLOCKSCOUT_BASE_URL ?? 'https://api.blockscout.com').trim() || 'https://api.blockscout.com',
  };
}
