import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkHolders, sharedSenders } from '../dist/clusters.js';

const addr = (c) => '0x' + c.repeat(40);
const [H1, H2, H3, H4, H5] = ['1', '2', '3', '4', '5'].map(addr);
const [S, X, D] = ['e', 'f', 'd'].map(addr); // sender, exchange, deployer

const holder = (address, share, extra = {}) => ({ address, share, isContract: false, name: null, ...extra });
const inflow = (peer, value = '100', block = 1, ts = 1000) => ({ peer, dir: 'in', value: String(value), block, ts, internal: false });
const outflow = (peer, value = '100', block = 1, ts = 1000) => ({ ...inflow(peer, value, block, ts), dir: 'out' });
const trace = (wallet, flows, extra = {}) => {
  const first = flows.find((f) => f.dir === 'in');
  return [wallet, { wallet, status: 'ok', funder: first?.peer ?? null, kind: first ? 'transfer' : null, firstTs: 0, flows, ...extra }];
};
const run = (holders, traces, { creator = null, txCounts = {}, options } = {}) =>
  linkHolders({ holders, creator, traces: new Map(traces), txCounts: new Map(Object.entries(txCounts)), options });

test('shared funder links holders when the sender is not infrastructure', () => {
  const r = run([holder(H1, 10), holder(H2, 5), holder(H3, 1)], [
    trace(H1, [inflow(S, 1, 1, 1000)]),
    trace(H2, [inflow(S, 2, 50, 9000)]),
    trace(H3, [inflow(X, 3, 99, 99999)]),
  ], { txCounts: { [S]: 40 } });
  assert.equal(r.clusters.length, 1);
  assert.deepEqual(r.clusters[0], { id: 1, members: [H1, H2], share: 15, reasons: ['shared funder'] });
  assert.equal(r.wallets[H1].cluster, 1);
  assert.equal(r.wallets[H3].cluster, null);
  assert.deepEqual(r.links, [{ a: H1, b: H2, reason: 'shared funder', via: S }]);
  assert.equal(r.stats.clusteredShare, 15);
});

test('an infrastructure sender alone links nobody', () => {
  const r = run([holder(H1, 10), holder(H2, 5)], [
    trace(H1, [inflow(X, 1, 1, 1000)]),
    trace(H2, [inflow(X, 2, 50, 9000)]),
  ], { txCounts: { [X]: 5_000_000 } });
  assert.equal(r.clusters.length, 0);
  assert.equal(r.senders[0].infrastructure, true);
});

test('an unreadable sender count is not treated as a link', () => {
  const r = run([holder(H1, 10), holder(H2, 5)], [
    trace(H1, [inflow(S, 1, 1, 1000)]),
    trace(H2, [inflow(S, 2, 50, 9000)]),
  ], { txCounts: { [S]: null } });
  assert.equal(r.clusters.length, 0);
  assert.equal(r.senders[0].infrastructure, null);
});

test('...but infrastructure paying two holders in one block is a batch', () => {
  const r = run([holder(H1, 10), holder(H2, 5)], [
    trace(H1, [inflow(X, 1, 777, 1000)]),
    trace(H2, [inflow(X, 2, 777, 1000)]),
  ], { txCounts: { [X]: 5_000_000 } });
  assert.deepEqual(r.clusters[0].reasons, ['same block']);
});

test('identical amounts need three wallets; two is coincidence', () => {
  const two = run([holder(H1, 3), holder(H2, 2)], [
    trace(H1, [inflow(X, '123456789', 1, 1)]),
    trace(H2, [inflow(X, '123456789', 2, 100000)]),
  ], { txCounts: { [X]: 9e6 } });
  assert.equal(two.clusters.length, 0);
  const three = run([holder(H1, 3), holder(H2, 2), holder(H3, 1)], [
    trace(H1, [inflow(X, '123456789', 1, 1)]),
    trace(H2, [inflow(X, '123456789', 2, 100000)]),
    trace(H3, [inflow(X, '123456789', 3, 200000)]),
  ], { txCounts: { [X]: 9e6 } });
  assert.deepEqual(three.clusters[0].reasons, ['identical amounts']);
  assert.equal(three.clusters[0].members.length, 3);
});

test('funded together: three within the window; windows anchor and never chain', () => {
  const r = run([holder(H1, 4), holder(H2, 3), holder(H3, 2), holder(H4, 1)], [
    trace(H1, [inflow(X, 1, 1, 1000)]),
    trace(H2, [inflow(X, 2, 2, 1100)]),
    trace(H3, [inflow(X, 3, 3, 1290)]),
    trace(H4, [inflow(X, 4, 4, 1500)]), // 500 s after the anchor: outside
  ], { txCounts: { [X]: 9e6 } });
  assert.equal(r.clusters.length, 1);
  assert.deepEqual(r.clusters[0].members, [H1, H2, H3]);
  assert.deepEqual(r.clusters[0].reasons, ['funded together']);
});

test('direct native transfer between two holders', () => {
  const r = run([holder(H1, 10), holder(H2, 5)], [
    trace(H1, [outflow(H2)]),
    trace(H2, [inflow(H1)]),
  ]);
  assert.deepEqual(r.clusters[0].reasons, ['direct transfer']);
  assert.equal(r.links.length, 1, 'the same pair is linked once per reason');
});

test('deployer: holders it funded are marked and linked, even if it is busy', () => {
  const r = run([holder(H1, 10), holder(H2, 5), holder(H3, 1)], [
    trace(H1, [inflow(D, 1, 1, 1)]),
    trace(H2, [inflow(D, 2, 9, 99999)]),
    trace(H3, [inflow(S)]),
  ], { creator: D, txCounts: { [D]: 9e9 } });
  assert.deepEqual(r.clusters[0].reasons, ['funded by deployer']);
  assert.equal(r.wallets[H1].deployerFunded, true);
  assert.equal(r.wallets[H3].deployerFunded, false);
  assert.equal(r.stats.deployerLinkedShare, 15);
});

test('deployer holding the token links to the holders it funded', () => {
  const r = run([holder(D, 20), holder(H1, 10)], [
    trace(D, []),
    trace(H1, [inflow(D)]),
  ], { creator: D });
  assert.equal(r.wallets[D].deployer, true);
  assert.deepEqual(r.clusters[0].members, [D, H1]);
  assert.ok(r.clusters[0].reasons.includes('funded by deployer'));
});

test('named contracts and sinks never link on native coin', () => {
  const many = Array.from({ length: 8 }, (_, i) => inflow('0x' + '9'.repeat(39) + i)); // 8 distinct outside senders
  const r = run([holder(H1, 30, { isContract: true, name: 'Uniswap V3: Pool' }), holder(H2, 10), holder(H3, 5), holder(H4, 2)], [
    trace(H1, [inflow(S)]),
    trace(H2, [...many, inflow(S)]), // 9 distinct senders: a sink
    trace(H3, [inflow(S)]),
    trace(H4, [inflow(X)]),
  ], { txCounts: { [S]: 10 } });
  assert.equal(r.wallets[H2].sink, true);
  assert.equal(r.clusters.length, 0, 'only H3 is left linkable on S');
});

test('weak first-tx funders are shown but never linked', () => {
  const r = run([holder(H1, 10), holder(H2, 5)], [
    [H1, { wallet: H1, status: 'ok', funder: S, kind: 'first-tx', firstTs: 0, flows: [] }],
    [H2, { wallet: H2, status: 'ok', funder: S, kind: 'first-tx', firstTs: 0, flows: [] }],
  ], { txCounts: { [S]: 10 } });
  assert.equal(r.wallets[H1].funder, S);
  assert.equal(r.clusters.length, 0);
});

test('failed and skipped traces are counted, not hidden', () => {
  const r = run([holder(H1, 10), holder(H2, 5), holder(H3, 1)], [
    trace(H1, []),
    [H2, { wallet: H2, status: 'error', funder: null, kind: null, firstTs: null, flows: [] }],
  ]);
  assert.equal(r.wallets[H2].trace, 'error');
  assert.equal(r.wallets[H3].trace, 'skipped');
  assert.deepEqual(r.stats, { traced: 2, failed: 1, clusteredShare: 0, deployerLinkedShare: 0 });
});

test('clusters are ordered by share and numbered from 1; members largest first', () => {
  const r = run([holder(H1, 1), holder(H2, 2), holder(H3, 30), holder(H4, 20), holder(H5, 3)], [
    trace(H1, [inflow(S)]), trace(H2, [inflow(S, 5, 9, 99999)]),
    trace(H3, [outflow(H4)]), trace(H4, [inflow(H3)]), trace(H5, []),
  ], { txCounts: { [S]: 5 } });
  assert.deepEqual(r.clusters.map((c) => [c.id, c.members]), [[1, [H3, H4]], [2, [H2, H1]]]);
});

test('sharedSenders lists outside senders of two or more holders only', () => {
  const holders = [holder(H1, 1), holder(H2, 1), holder(H3, 1)];
  const traces = new Map([trace(H1, [inflow(S), inflow(X)]), trace(H2, [inflow(S), inflow(H1)]), trace(H3, [inflow(H1)])]);
  assert.deepEqual(sharedSenders(holders, traces), [S]);
});
