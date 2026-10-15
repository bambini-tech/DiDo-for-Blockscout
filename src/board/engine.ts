/**
 * The analysis engine on the server: the same vendored block the page runs
 * (web/vendor/engine.js), evaluated once in a plain function scope. The board
 * reads tokens with exactly the engine the page draws zones with.
 */
import { readFileSync } from 'node:fs';

export interface EngineResult {
  score: number;
  stEntryLow: number | null; stEntryHigh: number | null; stTpLow: number | null; stTpHigh: number | null;
  ltEntryLow: number | null; ltEntryHigh: number | null; ltTpLow: number | null; ltTpHigh: number | null;
  [k: string]: unknown;
}

export interface Engine {
  analyze(df1: unknown, df4: unknown, volMcap: number, ageDays: number | null, buys: number, sells: number, token: unknown): EngineResult;
  tokenInfo(pair: unknown): Record<string, any>;
  dfLen(df: unknown): number;
  MIN_ANALYSIS_BARS: number;
}

let cached: Engine | null = null;

export function loadEngine(path = new URL('../../web/vendor/engine.js', import.meta.url)): Engine {
  if (cached) return cached;
  const src = readFileSync(path, 'utf8');
  const module = { exports: {} as Engine };
  // The block ends with `if (typeof module !== 'undefined' && module.exports) module.exports = DD;`
  new Function('module', src)(module);
  if (typeof module.exports.analyze !== 'function') throw new Error('vendored engine exports no analyze()');
  cached = module.exports;
  return cached;
}
