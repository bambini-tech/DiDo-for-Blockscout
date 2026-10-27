// Sprint 2: Blockscout labels, token-funded clusters, explorer links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, scriptedFetch, makeClient } from './helpers.mjs';
import { labelsOf } from '../dist/labels.js';
import { linkHolders } from '../dist/clusters.js';
import { traceFunding } from '../dist/blockscout/addresses.js';
import { fullPayload } from '../dist/holders.js';

const A = (c) => '0x' + c.repeat(40);
const E18 = 10n ** 18n;

test('labels: who an address is, from Blockscout name and tags', () => {
  assert.deepEqual(labelsOf(null, ['Binance: Hot Wallet 20', 'HOT WALLET', 'Exchange', 'Binance 8', 'Binance']),
    { label: 'Binance: Hot Wallet 20', entity: 'Binance', exchange: true, wallet: false });
  assert.deepEqual(labelsOf(null, ['Kraken 246', 'Exchange', 'Kraken']), { label: 'Kraken 246', entity: 'Kraken', exchange: true, wallet: false });
  assert.equal(labelsOf(null, ['OKX 219', 'Exchange', 'note_0']).entity, 'OKX');
  assert.deepEqual(labelsOf('GnosisSafeProxy', ['Chainlink: Noncirculating Supply 3', 'Smart Account by Safe', 'Chainlink']),
    { label: 'Chainlink: Noncirculating Supply 3', entity: 'Chainlink', exchange: false, wallet: true });
  assert.deepEqual(labelsOf('GnosisSafeProxy', []), { label: null, entity: null, exchange: false, wallet: true }, 'a bare Safe is a wallet with no name');
  assert.equal(labelsOf('Aave v3 LINK', ['Aave: Ethereum LINK V3', 'Token Contract', 'ALINK', 'Aave']).entity, 'Aave');
  assert.equal(labelsOf(null, ['Visit website LinkAward .org to claim your rewards']).label, null, 'an advert is not a label');
  assert.equal(labelsOf(null, []).label, null, 'nothing said, nothing guessed');
});

// Five multisigs a treasury (T) paid 30M of the token each, minutes apart: no ETH ever moved.
const tok = (peer, dir, value, ts, block, hash) => ({ peer, dir, value: String(value), block, ts, internal: false, hash });
const trace = (wallet, tokenFlows, extra = {}) => [wallet, { wallet, status: 'ok', funder: null, kind: null, firstTs: null, txCount: 3, windowFull: false, flows: [], tokenFlows, ...extra }];
const T = A('7'), SPAM = A('5');
const safes = ['1', '2', '3', '4', '6'].map(A);
const holdersOf = (list) => list.map((a) => ({ address: a, share: 3, isContract: true, name: 'GnosisSafeProxy', wallet: true, raw: String(30_000_000n * E18) }));

test('token funding: multisigs paid by one treasury within minutes form one cluster, with the proof', () => {
  const traces = new Map(safes.map((a, i) => trace(a, [
    tok(T, 'in', 1n * E18, 1000 + i * 60, 100 + i, `0xtest${i}`),                    // a 1-token test send: noise
    tok(T, 'in', 29_999_999n * E18, 1100 + i * 60, 200 + i, `0xfund${i}`),
    tok(SPAM, 'in', 1n, 5000, 900, '0xspam'),                                          // a dust drop, one block, to all: noise
  ])));
  const r = linkHolders({ holders: holdersOf(safes), creator: null, traces, txCounts: new Map([[T, 40], [SPAM, 3]]), tokenDecimals: 18 });
  assert.equal(r.clusters.length, 1);
  assert.deepEqual([...r.clusters[0].members].sort(), [...safes].sort());
  assert.deepEqual(r.clusters[0].reasons, ['shared funder', 'funded together']);
  assert.equal(r.clusters[0].tokenLinked, true);
  const l = r.links.find((x) => x.reason === 'shared funder');
  assert.equal(l.via, T);
  assert.equal(l.asset, 'token');
  assert.match(l.tx, /^0xfund\d$/, 'the funding transaction, not the test send');
  assert.ok(!r.links.some((x) => x.via === SPAM), 'a dust drop to every holder links nobody');
  assert.equal(r.wallets[safes[0]].funder, T, 'never paid native coin: funded by whoever sent it the token');
  assert.equal(r.wallets[safes[0]].fundingKind, 'token');
});

test('token funding: an exchange wallet never links a user who withdrew from it', () => {
  const ex = A('8'), user = A('9');
  const holders = [
    { address: ex, share: 5, isContract: false, name: null, exchange: true, raw: String(50n * E18) },
    { address: user, share: 1, isContract: false, name: null, raw: String(10n * E18) },
  ];
  const traces = new Map([trace(ex, [tok(user, 'in', 10n * E18, 1, 1, '0xa')]), trace(user, [tok(ex, 'in', 10n * E18, 1, 1, '0xa')])]);
  const r = linkHolders({ holders, creator: null, traces, txCounts: new Map(), tokenDecimals: 18 });
  assert.equal(r.clusters.length, 0);
});

test('a chain still indexing internal transactions: the trace stands on plain transactions', async () => {
  const W = A('a');
  const f = scriptedFetch([
    [(u) => u.searchParams.get('action') === 'txlist', json({ status: '1', message: 'OK', result: [{ from: W, to: A('b'), value: '5', timeStamp: '10', blockNumber: '1', hash: '0xh' }] })],
    [(u) => u.searchParams.get('action') === 'txlistinternal', json({ status: '0', message: 'Some internal transactions within this block range have not yet been processed', result: null })],
  ]);
  const t = await traceFunding(makeClient(f), 1, W, 20);
  assert.equal(t.status, 'ok');
  assert.equal(t.internalsPending, true);
  assert.equal(t.flows[0].hash, '0xh');
});

test('map payload: Blockscout labels, exchange custody out of the risk verdict, explorer and funding proof', () => {
  const ex1 = A('1'), ex2 = A('2'), safe = A('3'), funder = A('f');
  const holder = (address, share, extra = {}) => ({ address, raw: String(share), balance: share, share, isContract: false, name: null, tags: [], ...extra });
  const c = {
    chain: { key: 'ethereum', name: 'Ethereum', chainId: 1, explorer: 'https://eth.blockscout.com', native: 'ETH' },
    token: { address: A('c'), symbol: 'LINK', name: 'Chainlink', decimals: 18, totalSupply: '100', holderCount: 3 },
    holders: [
      holder(ex1, 20, { tags: ['Binance: Hot Wallet', 'Exchange', 'Binance'] }),
      holder(ex2, 15, { tags: ['Binance: Hot Wallet 20', 'Exchange', 'Binance'] }),
      holder(safe, 3, { isContract: true, name: 'GnosisSafeProxy' }),
    ],
    partial: false, fetchedAt: new Date(0).toISOString(),
    deployer: { address: null, status: 'ok' }, pools: [], burn: [],
    launch: { measured: false, launchTs: null, bundles: [], snipers: [] },
    labels: { [funder]: { name: null, tags: ['Chainlink: Treasury'], isContract: false } },
    analysis: {
      clusters: [{ id: 1, members: [ex1, ex2], share: 35, reasons: ['direct transfer'], tokenLinked: false }],
      links: [{ a: ex1, b: ex2, reason: 'direct transfer', tx: '0xproof' }],
      wallets: { [safe]: { trace: 'ok', funder, fundingKind: 'token', fundTx: '0xpaid', fundTs: 5 } },
      stats: { traced: 3, failed: 0 },
    },
    calls: 1,
  };
  const d = fullPayload(c);
  assert.equal(d.explorer, 'https://eth.blockscout.com');
  assert.equal(d.clusters[0].label, 'Binance');
  assert.equal(d.clusters[0].exchange, true);
  assert.equal(d.bubble_risk, 'Low', 'exchange custody is not one hand');
  assert.equal(d.exchange_pct, 35);
  assert.deepEqual(d.links[0], { source: ex1, target: ex2, kind: 'transfer', reason: 'direct transfer', tx: '0xproof' });
  const s = d.top_owners.find((o) => o.address === safe);
  assert.equal(s.kind, 'multisig');
  assert.equal(s.funder, funder);
  assert.equal(s.fund_tx, '0xpaid');
  assert.equal(s.funder_label, 'Chainlink: Treasury');
  assert.equal(d.top_owners.find((o) => o.address === ex1).label, 'Binance: Hot Wallet');
});

test('a payout contract never links the holders it pays on the token; on native coin only a batch does', () => {
  const C = A('c'), hs = ['1', '2', '3'].map(A);
  const holders = hs.map((a) => ({ address: a, share: 2, isContract: false, name: null, raw: String(1000n * E18) }));
  // Rewards paid by a contract, three holders in one block, identical amounts, repeatedly.
  const traces = new Map(hs.map((a, i) => trace(a, [tok(C, 'in', 500n * E18 + 7n, 100, 50, `0xr${i}`), tok(C, 'in', 300n * E18, 900, 60, `0xs${i}`)])));
  const r = linkHolders({ holders, creator: null, traces, txCounts: new Map([[C, 2]]), contractSenders: new Set([C]), tokenDecimals: 18 });
  assert.equal(r.clusters.length, 0, 'staking rewards are not one hand');
  // The same contract sending native coin to all three in one block is a disperse batch: still linked, but never as "shared funder".
  const native = new Map(hs.map((a, i) => [a, { wallet: a, status: 'ok', funder: C, kind: 'internal', firstTs: 1, txCount: 3, windowFull: false,
    flows: [{ peer: C, dir: 'in', value: '137264000000000', block: 77, ts: 1, internal: true, hash: `0xn${i}` }] }]));
  const n = linkHolders({ holders, creator: null, traces: native, txCounts: new Map([[C, 2]]), contractSenders: new Set([C]) });
  assert.equal(n.clusters.length, 1);
  assert.ok(!n.clusters[0].reasons.includes('shared funder'));
  assert.ok(n.clusters[0].reasons.includes('same block'));
});

test('a sender that could not be identified links nobody on the token', () => {
  const S = A('e'), hs = ['1', '2', '3'].map(A);
  const holders = hs.map((a) => ({ address: a, share: 2, isContract: false, name: null, raw: String(1000n * E18) }));
  const traces = new Map(hs.map((a, i) => trace(a, [tok(S, 'in', 500n * E18 + 7n, 100, 50, `0xr${i}`)])));
  const base = { holders, creator: null, traces, txCounts: new Map([[S, 5]]), tokenDecimals: 18 };
  assert.equal(linkHolders({ ...base, checkedSenders: new Set() }).clusters.length, 0, 'unchecked: no claim');
  assert.equal(linkHolders({ ...base, checkedSenders: new Set([S]) }).clusters.length, 1, 'checked and not a contract: linked');
});

test('an address page that fails still says whether it is a contract', async () => {
  const { getAddressLabels } = await import('../dist/blockscout/addresses.js');
  const C = A('c');
  const f = scriptedFetch([
    [`/api/v2/addresses/${C}`, json({ message: 'Internal server error' }, 500)],
    [(u) => u.searchParams.get('action') === 'getcontractcreation', json({ status: '1', message: 'OK', result: [{ contractAddress: C, contractCreator: A('d') }] })],
  ]);
  const r = await getAddressLabels(makeClient(f), 1, C);
  assert.equal(r.status, 'ok');
  assert.equal(r.isContract, true);
});
