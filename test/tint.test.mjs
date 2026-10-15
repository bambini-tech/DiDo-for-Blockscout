import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { palette, allowedLogo, tintOf } from '../dist/tint.js';
import { buildApp } from '../dist/server.js';
import { scriptedFetch, makeClient } from './helpers.mjs';

const px = (...rgba) => Uint8Array.from(rgba.flat());
const many = (n, p) => Array.from({ length: n }, () => p);

test('palette: the dominant hue, a distinct second, and nothing for a grey logo', () => {
  assert.deepEqual(palette(px(...many(60, [30, 100, 240, 255]))), ['#1e64f0']);
  const two = palette(px(...many(50, [30, 100, 240, 255]), ...many(30, [240, 160, 20, 255])));
  assert.deepEqual(two, ['#1e64f0', '#f0a014']);
  assert.deepEqual(palette(px(...many(50, [128, 128, 128, 255]), ...many(50, [250, 250, 250, 255]))), []);
  assert.deepEqual(palette(px(...many(50, [255, 0, 0, 0]))), [], 'transparent pixels are not colour');
});

test('only known image hosts are fetched', () => {
  assert.equal(allowedLogo('https://cdn.dexscreener.com/cms/images/x?width=800'), true);
  assert.equal(allowedLogo('https://assets.coingecko.com/coins/images/1/small/x.png'), true);
  assert.equal(allowedLogo('http://cdn.dexscreener.com/x'), false);
  assert.equal(allowedLogo('https://169.254.169.254/latest/meta-data'), false);
  assert.equal(allowedLogo('https://evil.example/x.png'), false);
});

test('a real PNG logo, end to end through the route', async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 20, g: 200, b: 90, alpha: 1 } } }).png().toBuffer();
  let calls = 0;
  const fetchImage = async () => { calls++; return new Response(png, { headers: { 'content-type': 'image/png' } }); };
  const app = buildApp({ client: makeClient(scriptedFetch([])), version: 't', fetchImage });
  const u = encodeURIComponent('https://cdn.dexscreener.com/cms/images/green-test');
  const r = (await app.inject(`/api/token-tint?u=${u}`)).json();
  assert.deepEqual(r, { ok: true, error: null, data: { colors: ['#14c85a'] } });
  await app.inject(`/api/token-tint?u=${u}`);
  assert.equal(calls, 1, 'one image read per logo, then memory');
  const refused = (await app.inject(`/api/token-tint?u=${encodeURIComponent('https://evil.example/a.png')}`)).json();
  assert.deepEqual(refused.data.colors, []);
  assert.equal(await tintOf('https://cdn.dexscreener.com/broken', async () => new Response('not an image')), null);
});
