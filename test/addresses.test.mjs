import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, scriptedFetch, makeClient } from './helpers.mjs';
import { traceFunding, getCreator, getTxCount } from '../dist/blockscout/addresses.js';

const W = '0x' + 'c'.repeat(40);
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const ok = (result) => json({ status: '1', message: 'OK', result });
const none = json({ status: '0', message: 'No transactions found', result: [] });
const tx = (from, to, value, block = 1, ts = 100, extra = {}) =>
  ({ from, to, value: String(value), blockNumber: String(block), timeStamp: String(ts), isError: '0', ...extra });
const byAction = (map) => scriptedFetch([[(u) => true, (u) => map[u.searchParams.get('action')] ?? json({}, 500)]]);

test('trace: first inbound transfer is the funder; every flow is kept; addresses lowercased', async () => {
  const f = byAction({ txlist: ok([
    tx(W.toUpperCase().replace('0X', '0x'), A, 5, 1, 90),   // outflow first
    tx(A.toUpperCase().replace('0X', '0x'), W, 10, 2, 100), // first inflow
    tx(B, W, 0, 3, 110),                                    // zero value: ignored
    tx(B, W, 7, 4, 120, { isError: '1' }),                  // failed: ignored
    tx(B, W, 3, 5, 130),
  ]) });
  const t = await traceFunding(makeClient(f), 1, W);
  assert.equal(t.status, 'ok');
  assert.equal(t.funder, A);
  assert.equal(t.kind, 'transfer');
  assert.equal(t.firstTs, 90);
  assert.deepEqual(t.flows.map((x) => `${x.dir}:${x.peer.slice(0, 4)}:${x.value}`), ['out:0xaa:5', 'in:0xaa:10', 'in:0xbb:3']);
  assert.equal(f.seen.length, 1, 'no internal read when a plain transfer funded it');
  assert.equal(f.seen[0].searchParams.get('sort'), 'asc');
});

test('trace: falls back to internal transfers (bridges, contracts)', async () => {
  const f = byAction({ txlist: ok([tx(W, A, 1)]), txlistinternal: ok([tx(B, W, 9, 7, 200)]) });
  const t = await traceFunding(makeClient(f), 1, W);
  assert.equal(t.funder, B);
  assert.equal(t.kind, 'internal');
  assert.ok(t.flows.some((x) => x.internal && x.peer === B));
});

test('trace: no inflow at all gives a weak first-tx funder', async () => {
  const f = byAction({ txlist: ok([{ ...tx(A, B, 0), value: '0' }]), txlistinternal: none });
  const t = await traceFunding(makeClient(f), 1, W);
  assert.equal(t.kind, 'first-tx');
  assert.equal(t.funder, A);
});

test('trace: empty history is ok with no funder; an outage is an error', async () => {
  const empty = await traceFunding(makeClient(byAction({ txlist: none, txlistinternal: none })), 1, W);
  assert.equal(empty.status, 'ok');
  assert.equal(empty.funder, null);
  const down = await traceFunding(makeClient(byAction({ txlist: json({}, 503) })), 1, W);
  assert.equal(down.status, 'error');
});

test('creator and tx count', async () => {
  const f = scriptedFetch([
    ['/counters', json({ transactions_count: '12345' })],
    ['/addresses/', json({ creator_address_hash: '0xABCDEF' + '0'.repeat(34) })],
  ]);
  const c = makeClient(f);
  assert.equal((await getCreator(c, 1, W)).creator, '0xabcdef' + '0'.repeat(34));
  assert.equal((await getTxCount(c, 1, W)).count, 12345);
  const gone = await getCreator(makeClient(scriptedFetch([['/addresses/', json({}, 404)]])), 1, W);
  assert.equal(gone.status, 'absent');
});
