import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scriptedFetch, makeClient } from './helpers.mjs';
import { buildApp } from '../dist/server.js';
import { CHAINS } from '../dist/chains.js';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p) => readFileSync(root(p), 'utf8');
const WEB = root('dist/web');

test('the bundle carries the vendored engine and holder map byte-for-byte', () => {
  const js = read('dist/web/dido.js');
  const css = read('dist/web/dido.css');
  assert.ok(js.includes(read('web/vendor/engine.js')));
  assert.ok(js.includes(read('web/vendor/holdermap.js')));
  assert.ok(css.includes(read('web/vendor/holdermap.css')));
  assert.ok(!js.includes('{{'), 'every placeholder stamped');
});

test('the page has nothing inline for the CSP to drop', () => {
  const html = read('dist/web/index.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /<style[\s>]/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(read('web/vendor/holdermap.js'), /\sstyle="/, 'the map never emits an inline style attribute');
});

test('the page knows exactly the chains the server reads, with the same explorers', () => {
  const js = read('web/src/dido.js');
  const supported = JSON.parse(js.match(/const SUPPORTED = new Set\((\[[^\]]*\])\)/)[1].replace(/'/g, '"'));
  const explorers = Function(`return ${js.match(/const EXPLORERS = (\{[^}]*\})/)[1]}`)();
  const toKey = (c) => (c === 'ethereum' ? 'eth' : c);
  assert.deepEqual([...new Set(supported.map(toKey))].sort(), CHAINS.map((c) => c.key).sort());
  for (const c of CHAINS) assert.equal(explorers[c.key === 'eth' ? 'ethereum' : c.key], c.explorer);
});

test('no private backend in the page: one origin plus the two price APIs', () => {
  const js = read('web/src/dido.js');
  assert.doesNotMatch(js, /api\.digitaldon\.net|analyzer\.digitaldon\.net/);
  const app = buildApp({ client: makeClient(scriptedFetch([])), version: 't', webDir: WEB });
  return app.inject('/').then((r) => {
    assert.equal(r.statusCode, 200);
    const csp = r.headers['content-security-policy'];
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /style-src 'self';/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(csp.match(/connect-src ([^;]*)/)[1], "'self' https://api.dexscreener.com https://api.geckoterminal.com");
  });
});

test('config tells the page whether the map is live', async () => {
  const on = buildApp({ client: makeClient(scriptedFetch([])), version: 't', webDir: WEB, holderIntel: true });
  assert.equal((await on.inject('/api/config')).json().holder_intel, true);
  const off = buildApp({ client: makeClient(scriptedFetch([])), version: 't', webDir: WEB, holderIntel: false });
  const c = (await off.inject('/api/config')).json();
  assert.equal(c.holder_intel, false);
  assert.equal(c.engine_version, read('web/vendor/ENGINE_VERSION').trim());
  const js = await on.inject('/dido.js');
  assert.equal(js.statusCode, 200);
  assert.match(js.headers['content-type'], /javascript/);
});

test('every let-go reason the board gives is one the page words', async () => {
  const { LET_GO_REASONS } = await import('../dist/board/read.js');
  const js = read('web/src/dido.js');
  const body = js.slice(js.indexOf('function reasonText(g)'), js.indexOf("default: return g.reason || 'let go'"));
  const worded = new Set([...body.matchAll(/case '([a-z_]+)'/g)].map((m) => m[1]));
  for (const r of LET_GO_REASONS) assert.ok(worded.has(r), `the page has no words for "${r}"`);
  const src = read('src/board/read.ts');
  // ...and every reason word the read uses is in the list (so the check above sees it).
  for (const [, w] of src.matchAll(/'([a-z_]+)'/g)) {
    if (worded.has(w)) assert.ok(LET_GO_REASONS.includes(w), `"${w}" is not listed in LET_GO_REASONS`);
  }
});
