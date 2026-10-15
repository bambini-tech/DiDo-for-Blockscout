/**
 * Re-checks data/chains.json against live data, with no API key:
 *
 *   1. Blockscout   the PRO API's own config (api.blockscout.com/api/json/config)
 *                   lists the chain id, as a mainnet
 *   2. GeckoTerminal the network has pools
 *   3. DexScreener  one of those exact pools comes back under the chain's key
 *                   (/latest/dex/pairs/{key}/{pool}) -- the id is proven by
 *                   data, not by its spelling
 *   4. GeckoTerminal that pool has hourly candles (what the engine reads)
 *   5. DexScreener  the wrapped gas coin (`wrapped`) trades on the chain under
 *                   the gas coin's symbol or its W- form
 *
 * Usage: npm run verify-chains [-- --candidates]
 *   --candidates  also list PRO API mainnets that are NOT in the file, with
 *                 the GeckoTerminal network they might match, to look at by hand.
 * Exits non-zero if any listed chain fails.
 */
import { readFileSync } from 'node:fs';

const chains = JSON.parse(readFileSync(new URL('../data/chains.json', import.meta.url), 'utf8')).chains;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastGt = 0;
async function get(url, { gt = false } = {}) {
  for (let i = 0; i < 5; i++) {
    if (gt) {
      const wait = lastGt + 4500 - Date.now();
      if (wait > 0) await sleep(wait);
      lastGt = Date.now();
    }
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(25_000) });
      if (res.status === 429) { await sleep(15_000 * (i + 1)); continue; }
      return res.ok ? await res.json() : null;
    } catch {
      await sleep(3000);
    }
  }
  return null;
}

const config = await get('https://api.blockscout.com/api/json/config');
if (!config) { console.error('could not read the Blockscout PRO API config'); process.exit(2); }
const meta = config.chains_metadata ?? {};
let failed = 0;

for (const c of chains) {
  const m = meta[String(c.chainId)];
  const problems = [];
  if (!config.chains?.[String(c.chainId)]) problems.push('not served by the Blockscout PRO API');
  else if (m?.isTestnet) problems.push('a testnet in the Blockscout PRO API');
  const pools = (await get(`https://api.geckoterminal.com/api/v2/networks/${c.gt}/pools?page=1`, { gt: true }))?.data ?? [];
  let proven = null;
  for (const p of pools.slice(0, 5)) {
    const addr = (p.attributes?.address ?? '').toLowerCase();
    if (!addr.startsWith('0x')) continue;
    const ds = await get(`https://api.dexscreener.com/latest/dex/pairs/${c.key}/${addr}`);
    if ((ds?.pairs ?? []).some((x) => x.chainId === c.key && (x.pairAddress ?? '').toLowerCase() === addr)) { proven = addr; break; }
  }
  if (!pools.length) problems.push(`GeckoTerminal network "${c.gt}" has no pools`);
  else if (!proven) problems.push(`no GeckoTerminal pool found on DexScreener under "${c.key}"`);
  else {
    const oh = await get(`https://api.geckoterminal.com/api/v2/networks/${c.gt}/pools/${proven}/ohlcv/hour?aggregate=1&limit=24&currency=usd`, { gt: true });
    if (!(oh?.data?.attributes?.ohlcv_list ?? []).length) problems.push('no candles on GeckoTerminal');
  }
  if (c.wrapped) {
    // The gas coin's ERC-20 (cash in the wallet scan's cost basis): a pool on
    // this chain must carry it, under the gas coin's symbol or its W- form.
    const rows = (await get(`https://api.dexscreener.com/tokens/v1/${c.key}/${c.wrapped}`)) ?? [];
    const names = new Set([c.native, `W${c.native}`].map((x) => x.toUpperCase()));
    const ok = rows.some((r) => r.chainId === c.key && [r.baseToken, r.quoteToken]
      .some((t) => (t?.address ?? '').toLowerCase() === c.wrapped && names.has((t?.symbol ?? '').toUpperCase())));
    if (!ok) problems.push(`wrapped ${c.native} ${c.wrapped} not found on DexScreener under "${c.key}"`);
  }
  if (problems.length) failed++;
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${String(c.chainId).padEnd(7)} ${c.name.padEnd(16)} ${problems.join('; ')}`);
}

if (process.argv.includes('--candidates')) {
  const listed = new Set(chains.map((c) => c.chainId));
  console.log('\nBlockscout PRO API mainnets not in data/chains.json:');
  for (const [id, url] of Object.entries(config.chains)) {
    if (listed.has(Number(id)) || meta[id]?.isTestnet !== false) continue;
    console.log(`  ${id.padEnd(10)} ${(meta[id]?.name ?? '?').padEnd(28)} ${url}`);
  }
}
console.log(`\n${chains.length - failed}/${chains.length} chains verified`);
process.exit(failed ? 1 : 0);
