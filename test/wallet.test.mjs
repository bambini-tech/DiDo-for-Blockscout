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
  assert.equal(Math.round(w.total_usd), 6000, 'dust is in the total, only folded out of the list');
  assert.equal(Math.round(w.tokens_usd), 1000);
  assert.equal(w.native_usd, 5000);
  assert.equal(w.holdings[0].address, null, 'a gas coin has no contract');
  assert.equal(w.dust, 1);
  assert.equal(w.unpriced, 1);
  assert.ok(!w.holdings.some((h) => h.symbol === 'FREE'), 'scam tokens are left out');
  assert.equal(w.ens, 'me.eth');
  assert.equal(w.tx_count, 42);
  assert.equal(w.nft_count, 1);
  assert.equal(w.nfts_more, true);
  assert.equal(w.pnl, null);
  assert.equal(w.pnl_pending, false);
  assert.ok(w.notes.includes('BASE: cost basis unavailable'), 'a history that could not be read is said, not hidden');
  assert.ok(w.notes.some((n) => n.startsWith('ARB: could not be read')));
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
  assert.equal(r.json().data.pnl_pending, true, 'the card goes out while the basis books');
  const done = await app.inject(`/api/wallet-scan/pnl?address=${W}`);
  assert.equal(done.json().data.pnl_pending, false);
  await new Promise((res) => setImmediate(res));
  const n = f.seen.length;
  await app.inject(`/api/wallet-scan?address=${W}`);
  assert.ok(f.seen.length > n, 'a scan with a failed chain is read again next time');
  const none = await app.inject(`/api/wallet-scan/pnl?address=${'0x' + 'f'.repeat(40)}`);
  assert.equal(none.statusCode, 404);
  assert.equal(none.json().error, 'not_pending', '/pnl never starts a scan of its own');
});

test('route: every chain down is an error, not an empty wallet', async () => {
  const app = buildApp({ client: makeClient(scriptedFetch([[() => true, json({}, 503)]])), version: 't' });
  const r = await app.inject(`/api/wallet-scan?address=${W}`);
  assert.equal(r.statusCode, 502);
  assert.equal(r.json().ok, false);
});

test('multichain discovery: one lookup, then only the chains the wallet is on (plus chains it does not index)', async () => {
  const { resetAggregatorCache } = await import('../dist/blockscout/multichain.js');
  resetAggregatorCache();
  const base = fetchFor();
  const seen = [];
  const f = async (url) => {
    const u = new URL(String(url));
    seen.push(u);
    if (u.pathname === '/multichain/api/v1/chains') return json({ items: [{ id: '1' }, { id: '8453' }, { id: '42161' }] }); // 4663 not indexed
    if (u.pathname === '/multichain/api/v1/addresses') return json({ items: [{ hash: W.toUpperCase().replace('0X', '0x'), chain_id: '8453' }] });
    return base(url);
  };
  const w = await scanWallet(makeClient(f), W, FOUR);
  const look = seen.find((u) => u.pathname === '/multichain/api/v1/addresses');
  assert.equal(look.searchParams.get('q'), W);
  assert.deepEqual(look.searchParams.getAll('chain_id').sort(), ['1', '42161', '8453'], 'only indexed chains are asked about');
  const probed = new Set(seen.filter((u) => /^\/\d+\/api\/v2\/addresses\/0x[0-9a-f]{40}$/.test(u.pathname)).map((u) => u.pathname.split('/')[1]));
  assert.deepEqual([...probed].sort(), ['4663', '8453'], 'Base (found) and Robinhood (not indexed); Ethereum and Arbitrum skipped');
  assert.deepEqual(w.chains.map((c) => c.chain), ['base']);
  assert.deepEqual(w.empty_chains.sort(), ['arbitrum', 'ethereum', 'robinhood']);
  assert.deepEqual(w.failed_chains, []);
  assert.deepEqual(w.discovery, { via: 'multichain', found_on: 1, probed: 1, skipped: 2 });
  assert.equal(Math.round(w.total_usd), 6000, 'the same wallet as the full probe');
});

test('multichain discovery: an aggregator failure falls back to probing every chain', async () => {
  const { resetAggregatorCache } = await import('../dist/blockscout/multichain.js');
  resetAggregatorCache();
  const base = fetchFor();
  const f = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/multichain/api/v1/chains') return json({ items: [{ id: '1' }, { id: '8453' }] });
    if (u.pathname === '/multichain/api/v1/addresses') return json({}, 400);
    return base(url);
  };
  const w = await scanWallet(makeClient(f), W, FOUR);
  assert.equal(w.discovery.via, 'probe');
  assert.equal(w.discovery.reason, 'aggregator lookup failed');
  assert.deepEqual(w.failed_chains, ['arbitrum'], 'every chain was probed: the outage is reported, not hidden');
  assert.deepEqual(w.chains.map((c) => c.chain), ['base']);
});

test('multichain discovery: the lookup is a standard 20-credit route', async () => {
  const { CreditLedger, PLANS } = await import('../dist/blockscout/credits.js');
  const l = new CreditLedger(PLANS.builder);
  assert.equal(l.priceOf('/multichain/api/v1/addresses'), 20);
  assert.equal(l.priceOf('/multichain/api/v1/chains'), 20);
});

// Base: 2 ETH; BIG bought for 1 ETH in one transaction; NOPX airdropped (no cash leg);
// an advert NFT; DexScreener knows NOPX (base side) and quotes another token against it.
function richFetch() {
  const tx = (hash, extra) => ({ hash, timeStamp: '100', isError: '0', ...extra });
  return scriptedFetch([
    [(u) => !u.pathname.startsWith('/8453/') && u.pathname !== '/v2/api', json({ message: 'Not found' }, 404)],
    [(u) => u.pathname === `/8453/api/v2/addresses/${W}`, json({ coin_balance: e18(2), exchange_rate: '2500', has_tokens: true })],
    [(u) => u.pathname === `/8453/api/v2/addresses/${W}/counters`, json({ transactions_count: '3' })],
    [(u) => u.pathname === `/8453/api/v2/addresses/${W}/token-balances`, json([
      { token: token(T1, 'BIG', '10'), value: e18(100) },
      { token: token(T3, 'NOPX', null), value: e18(7) },
    ])],
    [(u) => u.pathname === `/8453/api/v2/addresses/${W}/nft`, json({ items: [
      { id: '1', token_type: 'ERC-721', value: '1', image_url: null, metadata: { name: 'Claim your reward at x.com' }, token: token(T4, 'ADV', null, { type: 'ERC-721', name: 'Visit' }) },
      { id: '2', token_type: 'ERC-721', value: '1', image_url: null, metadata: null, token: token(T2, 'ART', null, { type: 'ERC-721', name: 'Art' }) },
    ] })],
    [(u) => u.pathname === '/v2/api' && u.searchParams.get('action') === 'txlist', json({ status: '1', result: [tx('0xa', { from: W, to: '0x' + '9'.repeat(40), value: e18(1) })] })],
    [(u) => u.pathname === '/v2/api' && u.searchParams.get('action') === 'txlistinternal', json({ status: '0', message: 'No transactions found', result: [] })],
    [(u) => u.pathname === '/v2/api' && u.searchParams.get('action') === 'tokentx', json({ status: '1', result: [
      tx('0xa', { from: '0x' + '9'.repeat(40), to: W, value: e18(100), contractAddress: T1, tokenSymbol: 'BIG', tokenDecimal: '18' }),
      tx('0xb', { from: '0x' + '8'.repeat(40), to: W, value: e18(7), contractAddress: T3, tokenSymbol: 'NOPX', tokenDecimal: '18' }),
    ] })],
  ]);
}
const BASE = CHAINS.filter((c) => c.chainId === 8453);
const pricer = (asked = []) => ({
  async pairs(chain, addresses) {
    asked.push([chain, addresses]);
    return [
      { chainId: 'base', baseToken: { address: T3, symbol: 'NOPX' }, priceUsd: '3', liquidity: { usd: 50000 }, info: { imageUrl: 'https://cdn.dexscreener.com/n.png' } },
      { chainId: 'base', baseToken: { address: T3, symbol: 'NOPX' }, priceUsd: '99', liquidity: { usd: 10 } },
      { chainId: 'base', baseToken: { address: T2, symbol: 'OTHER' }, quoteToken: { address: T1 }, priceUsd: '5000', liquidity: { usd: 1e6 } },
    ];
  },
});

test('tokens Blockscout cannot price are priced on DexScreener: deepest pool, base side only', async () => {
  const asked = [];
  const w = await scanWallet(makeClient(richFetch()), W, BASE, 'probe', { pricer: pricer(asked), pnl: false });
  assert.deepEqual(asked[0][0], 'base');
  assert.equal(asked[0][1][0], T3, 'the unpriced token is looked up first');
  const nopx = w.holdings.find((h) => h.symbol === 'NOPX');
  assert.equal(nopx.price_usd, 3, 'the deepest pool, not the shallow one');
  assert.equal(nopx.price_source, 'dexscreener');
  assert.equal(nopx.logo, 'https://cdn.dexscreener.com/n.png');
  assert.equal(w.holdings.find((h) => h.symbol === 'BIG').price_usd, 10, "a quote-side pool never prices a token, and Blockscout's rate stands");
  assert.equal(w.unpriced, 0);
  assert.equal(Math.round(w.total_usd), 5000 + 1000 + 21);
});

test('cost basis from the wallet history: a buy paid in the gas coin, an airdrop without one', async () => {
  const w = await scanWallet(makeClient(richFetch()), W, BASE, 'probe', { pricer: pricer() });
  const big = w.holdings.find((h) => h.symbol === 'BIG');
  assert.equal(Math.round(big.pnl.basis_usd), 2500, '1 ETH at today\'s 2,500');
  assert.equal(Math.round(big.pnl.pct), -60);
  assert.equal(w.holdings.find((h) => h.symbol === 'NOPX').pnl, null, 'no payment seen: no basis, never a free one');
  assert.equal(w.pnl.positions, 1);
  assert.equal(w.pnl.positions_total, 2);
  assert.equal(Math.round(w.pnl.coverage_pct), Math.round((1000 / 1021) * 100));
  assert.deepEqual(w.pnl.chains, ['base']);
});

test('the card goes out before the basis; adverts among the NFTs are counted, not shown', async () => {
  const { startWalletScan } = await import('../dist/wallet.js');
  const { card, finished } = await startWalletScan(makeClient(richFetch()), W, BASE, 'probe', { pricer: pricer() });
  assert.equal(card.pnl_pending, true);
  assert.equal(card.holdings.find((h) => h.symbol === 'BIG').pnl, null);
  const full = await finished;
  assert.ok(full.holdings.find((h) => h.symbol === 'BIG').pnl, 'booked on the finished scan');
  assert.equal(card.holdings.find((h) => h.symbol === 'BIG').pnl, null, 'the card already out is never changed');
  assert.deepEqual(full.nfts.map((n) => n.collection), ['Art']);
  assert.equal(full.nfts[0].name, 'Art #2');
  assert.equal(full.nfts_hidden, 1);
});

test('has_tokens false: no token or NFT reads on that chain', async () => {
  const f = scriptedFetch([
    [(u) => u.pathname === `/8453/api/v2/addresses/${W}`, json({ coin_balance: e18(1), exchange_rate: '2500', has_tokens: false })],
    [(u) => u.pathname === `/8453/api/v2/addresses/${W}/counters`, json({ transactions_count: '1' })],
  ]);
  const w = await scanWallet(makeClient(f), W, BASE, 'probe');
  assert.equal(w.total_usd, 2500);
  assert.ok(!f.seen.some((u) => /token-balances|\/nft|\/v2\/api/.test(u.pathname)), 'nothing read that cannot exist');
});
