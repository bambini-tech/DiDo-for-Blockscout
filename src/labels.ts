/**
 * Who an address is, from what Blockscout already says about it: the
 * contract name and the public tags on every holder row (`metadata.tags`).
 *
 *   label     the one line a reader sees: "Binance: Hot Wallet 20", "Kraken 246",
 *             "Aave v3 LINK". A tag that names its owner ("Binance: ...") beats
 *             the bare contract name.
 *   entity    who stands behind it, when a tag says so: "Binance", "Chainlink".
 *             Clusters are named after the entity their members share.
 *   exchange  Blockscout tags it as an exchange wallet: custody for many users,
 *             not one holder.
 *   wallet    a contract that is a wallet (a Safe, a multisig, a smart
 *             account): traced and linked like any wallet, where other named
 *             contracts (pools, vaults, staking) are not.
 *
 * Nothing is guessed: an address Blockscout says nothing about has no label.
 */

export interface Labels {
  label: string | null;
  entity: string | null;
  exchange: boolean;
  wallet: boolean;
}

/** Tags that describe a kind of address, not who owns it. */
const GENERIC = /^(exchange|hot wallet|cold wallet|deposit address|token contract|smart account by safe|beacon depositor|multisig|note_\d+|wallet)$/i;
/** A "tag" that is an advert (address-poisoning spam names itself after a claim site). */
const ADVERT = /https?:|www\.|\.(com|org|io|net|xyz|app|site|top|vip|claim)\b|\b(claim|reward|rewards|visit|airdrop|voucher|bonus)\b/i;
const WALLET_CONTRACT = /^(gnosis)?safe(proxy|l2)?$|multisig|smart ?account|smart ?wallet/i;
const WALLET_TAG = /smart account|\bsafe\b|multisig/i;

export function labelsOf(name: string | null, tags: readonly string[]): Labels {
  const clean = tags.map((t) => t.trim()).filter((t) => t && !GENERIC.test(t) && !ADVERT.test(t));
  const owned = clean.find((t) => t.includes(':'));
  const contractName = name && !WALLET_CONTRACT.test(name) ? name : null;
  const label = owned ?? clean[0] ?? contractName ?? null;
  // The entity: a tag that is the owner part of the label ("Binance" in
  // "Binance: Hot Wallet 20", "Kraken" in "Kraken 246"), or the owner part itself.
  let entity: string | null = null;
  if (label) {
    const head = label.includes(':') ? label.split(':')[0]!.trim() : null;
    const named = clean
      .filter((t) => !t.includes(':') && t.length < label.length && label.toLowerCase().startsWith(t.toLowerCase()))
      .sort((a, b) => a.length - b.length)[0];
    // "OKX 219", "Bithumb 91": an exchange's numbered wallets name the exchange.
    const numbered = /^(.*\D)\s+\d+$/.exec(label)?.[1]?.trim() ?? null;
    entity = named ?? head ?? numbered;
  }
  return {
    label,
    entity,
    exchange: tags.some((t) => /^exchange$/i.test(t.trim())),
    wallet: Boolean((name && WALLET_CONTRACT.test(name)) || tags.some((t) => WALLET_TAG.test(t))),
  };
}
