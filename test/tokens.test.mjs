import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, scriptedFetch, makeClient } from './helpers.mjs';
import { getTokenMeta, getTokenHolders } from '../dist/blockscout/tokens.js';

const TOKEN = '0x' + 'a'.repeat(40);
const tokenRow = {
  address_hash: '0x' + 'A'.repeat(40), name: 'Test', symbol: 'TST', decimals: '18',
  total_supply: '1000000000000000000000', holders_count: '1234', icon_url: null, type: 'ERC-20',
};
const holder = (hash, value, extra = {}) => ({ value, address: { hash, is_contract: false, name: null, ...extra } });

test('meta: parses the token row, lowercases the address', async () => {
  const f = scriptedFetch([[`/tokens/${TOKEN}`, json(tokenRow)]]);
  const { meta, status } = await getTokenMeta(makeClient(f), 1, TOKEN);
  assert.equal(status, 'ok');
  assert.equal(meta.address, TOKEN);
  assert.equal(meta.decimals, 18);
  assert.equal(meta.holderCount, 1234);
  assert.equal(meta.totalSupply, '1000000000000000000000');
});

test('meta: legacy `holders` field still gives a holder count', async () => {
  const { holders_count, ...legacy } = tokenRow;
  const f = scriptedFetch([[`/tokens/${TOKEN}`, json({ ...legacy, holders: '77' })]]);
  const { meta } = await getTokenMeta(makeClient(f), 1, TOKEN);
  assert.equal(meta.holderCount, 77);
});

test('meta: unknown token is absent, outage is error', async () => {
  const absent = await getTokenMeta(makeClient(scriptedFetch([['/tokens/', json({}, 404)]])), 1, TOKEN);
  assert.equal(absent.status, 'absent');
  const down = await getTokenMeta(makeClient(scriptedFetch([['/tokens/', json({}, 503)]])), 1, TOKEN);
  assert.equal(down.status, 'error');
});

test('holders: shares in BigInt, balances scaled, tags flattened, pages followed', async () => {
  const meta = (await getTokenMeta(makeClient(scriptedFetch([[`/tokens/${TOKEN}`, json(tokenRow)]])), 1, TOKEN)).meta;
  const page1 = {
    items: [
      holder('0x' + '1'.repeat(40), '250000000000000000000', { metadata: { tags: [{ name: 'Exchange' }, 'hot wallet'] } }),
      holder('0x' + '2'.repeat(40), '100000000000000000000', { is_contract: true, name: 'Pool' }),
    ],
    next_page_params: { items_count: 50, value: '1' },
  };
  const page2 = { items: [holder('0x' + '3'.repeat(40), '1')], next_page_params: null };
  const f = scriptedFetch([[(u) => u.pathname.endsWith('/holders'), (u) => json(u.searchParams.get('items_count') ? page2 : page1)]]);
  const { holders, status, partial } = await getTokenHolders(makeClient(f), 1, meta);
  assert.equal(status, 'ok');
  assert.equal(partial, false);
  assert.equal(holders.length, 3);
  assert.equal(holders[0].share, 25);
  assert.equal(holders[0].balance, 250);
  assert.deepEqual(holders[0].tags, ['Exchange', 'hot wallet']);
  assert.equal(holders[1].isContract, true);
  assert.equal(holders[1].name, 'Pool');
  assert.equal(holders[2].share, 0);
  assert.equal(f.seen[1].searchParams.get('items_count'), '50', 'keyset params passed on');
});

test('holders: a failure after page one keeps what was read and says partial', async () => {
  const meta = { address: TOKEN, decimals: 0, totalSupply: '100' };
  let n = 0;
  const f = scriptedFetch([['/holders', () => (n++ === 0
    ? json({ items: [holder('0x' + '1'.repeat(40), '10')], next_page_params: { p: 2 } })
    : json({}, 503))]]);
  const r = await getTokenHolders(makeClient(f), 1, meta);
  assert.equal(r.status, 'ok');
  assert.equal(r.partial, true);
  assert.equal(r.holders.length, 1);
  assert.equal(r.holders[0].share, 10);
});

test('holders: a failure on page one is an error, not "no holders"', async () => {
  const meta = { address: TOKEN, decimals: 0, totalSupply: '100' };
  const r = await getTokenHolders(makeClient(scriptedFetch([['/holders', json({}, 503)]])), 1, meta);
  assert.equal(r.status, 'error');
});
