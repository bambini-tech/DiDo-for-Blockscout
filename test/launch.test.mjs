import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, scriptedFetch, makeClient } from './helpers.mjs';
import { readLaunch, topicAddress, TRANSFER_TOPIC } from '../dist/blockscout/launch.js';

const TOKEN = '0x' + 't'.repeat(0) + 'a'.repeat(40);
const POOL = '0x' + 'b'.repeat(40);
const DEV = '0x' + 'd'.repeat(40);
const [W1, W2, W3, W4] = ['1', '2', '3', '4'].map((c) => '0x' + c.repeat(40));
const topic = (a) => '0x' + '0'.repeat(24) + a.slice(2);
const log = (from, to, amount, block, ts) => ({
  topics: [TRANSFER_TOPIC, topic(from), topic(to)],
  data: '0x' + BigInt(amount).toString(16).padStart(64, '0'),
  blockNumber: '0x' + block.toString(16),
  timeStamp: '0x' + ts.toString(16),
});
const logsFetch = (logs) => scriptedFetch([[(u) => u.searchParams.get('action') === 'getLogs', json({ status: '1', message: 'OK', result: logs })]]);

test('first buy from the pool marks the launch; same block = bundle, within 60 s = sniper', async () => {
  const f = logsFetch([
    log(DEV, POOL, 1000, 100, 1000),   // liquidity add: not a buy
    log(POOL, W1, 50, 101, 1012),      // launch block
    log(POOL, W2, 30, 101, 1012),      // same block: bundle
    log(POOL, W3, 20, 103, 1040),      // 28 s later: sniper
    log(POOL, W1, 5, 104, 1050),       // W1 again: stays a bundle
    log(POOL, W4, 10, 140, 1300),      // too late: stops the read
  ]);
  const r = await readLaunch(makeClient(f), 1, TOKEN, 99, new Set([POOL]), new Set([DEV]));
  assert.equal(r.measured, true);
  assert.equal(r.launchBlock, 101);
  assert.equal(r.launchTs, 1012);
  assert.deepEqual(r.bundles.map((b) => [b.buyer, b.raw]).sort(), [[W1, '50'], [W2, '30']]);
  assert.deepEqual(r.snipers.map((b) => b.buyer), [W3]);
  const q = f.seen[0].searchParams;
  assert.equal(q.get('module'), 'logs');
  assert.equal(q.get('address'), TOKEN);
  assert.equal(q.get('topic0'), TRANSFER_TOPIC);
  assert.equal(q.get('fromBlock'), '99');
});

test('decimal block numbers and timestamps read the same as hex', async () => {
  const dec = (l) => ({ ...l, blockNumber: String(parseInt(l.blockNumber, 16)), timeStamp: String(parseInt(l.timeStamp, 16)) });
  const r = await readLaunch(makeClient(logsFetch([dec(log(POOL, W1, 1, 7, 70)), dec(log(POOL, W2, 1, 8, 80))])), 1, TOKEN, 1, new Set([POOL]), new Set());
  assert.equal(r.launchBlock, 7);
  assert.deepEqual(r.snipers.map((b) => b.buyer), [W2]);
});

test('no buy from a known pool is "not measured", never "no snipers"', async () => {
  const r = await readLaunch(makeClient(logsFetch([log(DEV, W1, 1, 5, 50)])), 1, TOKEN, 1, new Set([POOL]), new Set());
  assert.equal(r.measured, false);
  const noPools = await readLaunch(makeClient(logsFetch([])), 1, TOKEN, 1, new Set(), new Set());
  assert.equal(noPools.measured, false);
});

test('an outage is an error', async () => {
  const f = scriptedFetch([[() => true, json({}, 503)]]);
  const r = await readLaunch(makeClient(f), 1, TOKEN, 1, new Set([POOL]), new Set());
  assert.equal(r.status, 'error');
});

test('topicAddress takes the last 20 bytes, lowercased', () => {
  assert.equal(topicAddress('0x000000000000000000000000ABCDEF0000000000000000000000000000000001'), '0xabcdef0000000000000000000000000000000001');
  assert.equal(topicAddress(null), null);
});
