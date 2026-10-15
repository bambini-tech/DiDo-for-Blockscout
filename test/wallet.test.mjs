import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, scriptedFetch, makeClient } from './helpers.mjs';
import { scanWallet } from '../dist/wallet.js';
import { buildApp } from '../dist/server.js';
import { CHAINS } from '../dist/chains.js';
const FOUR = CHAINS.filter((c) => [1, 8453, 42161, 4663].includes(c.chainId));

const W = '0x' + 'c'.repeat(40);
const [T1, T2, T3, T4, SCAM] = ['1', '2', '3', '4', '5'].map((c) => '0x' + c.repeat(40));
const token = (address, symbol, rate, extra = {}) => ({ address_hash: address, symbol, name: symbol, decimals: '18', exchange_rate: rate, holders_count: '10', icon_url: null, type: 'ERC-20', ...extra });
const e18 = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n + '';

// Base holds tokens; Ethereum knows the wallet but holds nothing; Arbitrum is down; Robinhood never saw it.
function fetchFor() {
  return scriptedFetch([
    [(u) => u.pathname.startsWith('/42161/'), json({}, 503)],
    [(u) => u.pathname.startsWith('/4663/'), json({ message: 'Not found' }, 404)],
    [(u) => u.pathname === `/8453/api/v2/addresses/${W}`, json({ coin_balance: e18(2), exchange_rate: '2500', is_contract: false, ens_domain_name: 'me.eth', name: null })],
    [(u) => u.pathname === `/8453/api/v2/addresses/${W}/counters`, json({ transactions_count: '42' })],
    [(u) => u.pathname === `/8453/api/v2/addresses/${W}/token-balances`, json([
      { token: token(T1, 'BIG', '10'), value: e18(100) },          // $1,000
      { token: token(T2, 'DUST', '0.001'), value: e18(5) },        // $0.005: dust
      { token: token(T3, 'NOPX', null), value: e18(7) },           // unpriced
      { token: token(SCAM, 'FREE', '1', { reputation: 'scam' }), value: e18(1e6) },
      { token: token(T4, 'NFT', null, { type: 'ERC-721' }), value: '1' },
    ])],
    [(u) => u.pathname === `/8453/api/v2/addresses/${W}/nft`, json({ items: [{ id: '7', token_type: 'ERC-721', value: '1', image_url: null, metadata: { name: 'Seven' }, token: token(T4, 'NFT', null, { type: 'ERC-721', name: 'Coll' }) }], next_page_params: { p: 2 } })],
    [(u) => u.pathname === `/1/api/v2/addresses/${W}`, json({ coin_balance: '0', exchange_rate: '2500', is_contract: false })],
    [(u) => u.pathname.startsWith(`/1/api/v2/addresses/${W}/`), json([])],
  ]);
}

test('a wallet across every chain: priced, dust, unpriced, scam, empty and failed chains', async () => {
  const w = await scanWallet(makeClient(fetchFor()), W.toUpperCase().replace('0X', '0x'), FOUR);
  assert.equal(w.address, W);
  assert.deepEqual(w.chains.map((c) => c.chain), ['base']);
  assert.deepEqual(w.empty_chains.sort(), ['ethereum', 'robinhood']);
  assert.deepEqual(w.failed_chains, ['arbitrum'], 'an outage is never "holds nothing"');
  assert.deepEqual(w.holdings.map((h) => [h.symbol, Math.round(h.usd), Math.round(h.pct)]), [['ETH', 5000, 83], ['BIG', 1000, 17]]);
  assert.equal(w.total_usd, 6000);
  assert.equal(w.tokens_usd, 1000);
  assert.equal(w.native_usd, 5000);
  assert.equal(w.dust, 1);
  assert.equal(w.unpriced, 1);
  assert.ok(!w.holdings.some((h) => h.symbol === 'FREE'), 'scam tokens are left out');
  assert.equal(w.ens, 'me.eth');
  assert.equal(w.tx_count, 42);
  assert.equal(w.nft_count, 1);
  assert.equal(w.nfts_more, true);
  assert.equal(w.pnl, null);
  assert.equal(w.pnl_pending, false);
  assert.equal(w.chains[0].native.usd, 5000);
  assert.equal(w.chains[0].chain_label, 'BASE');
});

test('route: envelope, bad address, cache, and a failed chain is not cached', async () => {
  const f = fetchFor();
  const app = buildApp({ client: makeClient(f), version: 't' });
  const bad = await app.inject('/api/wallet-scan?address=0x12');
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'invalid_address');
  const r = await app.inject(`/api/wallet-scan?address=${W}&defer=1`);
  assert.equal(r.json().ok, true);
  const n = f.seen.length;
  await app.inject(`/api/wallet-scan/pnl?address=${W}`);
  assert.ok(f.seen.length > n, 'a scan with a failed chain is read again next time');
});

test('route: every chain down is an error, not an empty wallet', async () => {
  const app = buildApp({ client: makeClient(scriptedFetch([[() => true, json({}, 503)]])), version: 't' });
  const r = await app.inject(`/api/wallet-scan?address=${W}`);
  assert.equal(r.statusCode, 502);
  assert.equal(r.json().ok, false);
});
