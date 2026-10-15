import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullPayload, TOP_OWNERS } from '../dist/holders.js';

const addr = (i) => '0x' + i.toString(16).padStart(40, '0');
// 80 holders, ranked by balance; a group joins rank 2 with ranks 70 and 75.
const holders = Array.from({ length: 80 }, (_, i) => ({
  address: addr(i + 1), raw: String(1000 - i), balance: 1000 - i, share: 0.5, isContract: false, name: null, tags: [],
}));
const [a, b, c] = [addr(2), addr(70), addr(75)];
const response = {
  chain: { key: 'base', name: 'Base', chainId: 8453, explorer: '' },
  token: { address: addr(999), symbol: 'T', name: 'T', decimals: 0, totalSupply: '100000', holderCount: 80 },
  holders, partial: false, fetchedAt: new Date(0).toISOString(),
  deployer: { address: null, status: 'absent' }, pools: [], burn: [],
  launch: { measured: false, launchTs: null, bundles: [], snipers: [] },
  analysis: {
    clusters: [{ members: [a, b, c], share: 1.5, reasons: ['shared funder'] }],
    links: [{ a, b, reason: 'shared funder', via: addr(500) }, { a, b: c, reason: 'shared funder', via: addr(500) }],
    wallets: { [b]: { trace: 'ok', fresh: true } },
    stats: { traced: 80, failed: 0 },
  },
  calls: 1,
};

test('every member of a drawn group is on the map, the ones below the top flagged beyond', () => {
  const d = fullPayload(response);
  const top = d.top_owners.filter((o) => !o.beyond);
  assert.equal(top.length, TOP_OWNERS);
  assert.deepEqual(d.top_owners.filter((o) => o.beyond).map((o) => [o.address, o.rank]), [[b, 70], [c, 75]]);
  assert.equal(d.top_owners.length, TOP_OWNERS + 2);
  assert.deepEqual(d.links.map((l) => l.target).sort(), [b, c].sort(), 'links to the group wallets below the top are drawn');
  assert.equal(d.clusters[0].wallets, 3);
  assert.equal(d.fresh_n, 0, 'summary counts stay on the top holders');
  assert.deepEqual(d.top_owners.find((o) => o.address === b).roles, ['fresh'], 'the wallet still carries its roles');
});
