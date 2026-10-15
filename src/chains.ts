/**
 * The chains DiDo for Blockscout reads: every Blockscout PRO API mainnet that
 * DexScreener and GeckoTerminal also cover, from data/chains.json (the one
 * list the server, the board, the wallet scan and the page all read).
 *
 *   key       DexScreener's chain id -- what the page and the market data key on
 *   chainId   the EVM chain id -- what the Blockscout PRO API gateway keys on
 *   gt        GeckoTerminal's network id (candles, trending pools)
 *   explorer  the chain's Blockscout explorer
 *
 * Each entry was checked against live data, never guessed: a wrong id does
 * not fail loudly, it reads as "this token has no holders". `npm run
 * verify-chains` re-checks the list.
 */
import { readFileSync } from 'node:fs';

export interface Chain {
  key: string;
  name: string;
  chainId: number;
  /** Short tag on chips (BASE, ARB, POL). */
  label: string;
  /** Two-letter code in watchlist links. */
  code: string;
  /** Native coin symbol (gas). */
  native: string;
  gt: string;
  explorer: string;
}

export const CHAINS: readonly Chain[] = (
  JSON.parse(readFileSync(new URL('../data/chains.json', import.meta.url), 'utf8')) as { chains: Chain[] }
).chains;

/** Other names a URL or a caller may use. */
const ALIASES: Record<string, string> = { eth: 'ethereum', rh: 'robinhood', arb: 'arbitrum', op: 'optimism', matic: 'polygon', pol: 'polygon', flow: 'flowevm', 'world-chain': 'worldchain' };

export function chainByKey(key: string): Chain | undefined {
  const k = key.toLowerCase();
  return CHAINS.find((c) => c.key === (ALIASES[k] ?? k));
}
