/**
 * The chains DiDo for Blockscout reads. Every one is served by the Blockscout
 * PRO API's multichain gateway under its EVM chain id, so adding a chain is
 * one entry here -- as long as the id is the real one. A wrong id does not
 * fail loudly: it reads as "this token has no holders".
 */
export interface Chain {
  key: string;
  name: string;
  chainId: number;
  explorer: string;
}

export const CHAINS: readonly Chain[] = [
  { key: 'eth', name: 'Ethereum', chainId: 1, explorer: 'https://eth.blockscout.com' },
  { key: 'base', name: 'Base', chainId: 8453, explorer: 'https://base.blockscout.com' },
  { key: 'arbitrum', name: 'Arbitrum One', chainId: 42161, explorer: 'https://arbitrum.blockscout.com' },
];

export function chainByKey(key: string): Chain | undefined {
  return CHAINS.find((c) => c.key === key.toLowerCase());
}
