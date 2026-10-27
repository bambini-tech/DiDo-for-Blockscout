/**
 * Build the DiDo page into dist/web/.
 *
 * Inputs, all inside this repo:
 *   web/src/          DiDo's page, stylesheet and app script, and the holder
 *                     map (JS + CSS): this edition's own fork of DigitalDon's,
 *                     with Blockscout labels and explorer links
 *   web/vendor/       the analysis engine, the brand mark and ENGINE_VERSION --
 *                     a snapshot taken from DigitalDon (see web/vendor/SOURCE.md).
 *                     Not edited here.
 *
 * Output (dist/web/, gitignored):
 *   index.html    the page; CSS and JS linked, never inline, so the server can
 *                 send script-src 'self' / style-src 'self'
 *   dido.js       engine + holder map + app in one IIFE; nothing on window
 *   dido.css      the stylesheet, host chrome first, the holder-map CSS last
 *   manifest.json versions + build time, served at /version
 *
 * Usage: node web/build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(HERE, 'src');
const VENDOR = join(HERE, 'vendor');
const DIST = join(ROOT, 'dist', 'web');

const die = (msg) => {
  console.error(`web build: ${msg}`);
  process.exit(1);
};
const read = (dir, f) => readFileSync(join(dir, f), 'utf8');

const VERSION = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
const ENGINE_VERSION = read(VENDOR, 'ENGINE_VERSION').trim();
const BUILT_AT = new Date().toISOString();
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) die(`VERSION must be X.Y.Z, got "${VERSION}"`);

const engine = read(VENDOR, 'engine.js');
const holderJs = read(SRC, 'holdermap.js');
const holderCss = read(SRC, 'holdermap.css');
// The chains, from the one list the server reads too.
const CHAINS = JSON.parse(readFileSync(join(ROOT, 'data', 'chains.json'), 'utf8')).chains
  .map(({ key, name, label, code, gt, explorer }) => ({ key, name, label, code, gt, explorer }));
if (!CHAINS.length || !CHAINS.some((c) => c.key === 'ethereum')) die('data/chains.json has no chains (or no ethereum)');
if (!engine.startsWith('/*ENGINE-START*/') || !engine.trimEnd().endsWith('/*ENGINE-END*/')) die('vendor/engine.js lost its markers');
for (const fn of ['holderFullSectionHtml', 'initHolderMap', 'holderGroupsLine']) {
  if (!holderJs.includes(`function ${fn}`)) die(`src/holdermap.js is missing ${fn}()`);
}
// The map may use only `esc` and `DD` from its host; it must at least parse with those.
try {
  new Function('esc', 'DD', holderJs);
} catch (e) {
  die(`src/holdermap.js does not parse: ${e.message}`);
}

// The brand mark, inlined: bare paths inheriting currentColor (the brand is monochrome).
const logoSvg = read(VENDOR, 'logo-mark.svg').replace(/<\?xml[^>]*>\s*/i, '').trim();
if (!/^<svg[\s>]/i.test(logoSvg)) die('logo-mark.svg does not start with <svg>');
for (const m of logoSvg.matchAll(/\b(?:fill|stroke)\s*=\s*"([^"]*)"/g)) {
  const v = m[1].trim().toLowerCase();
  if (!['currentcolor', 'none', '#000', '#000000', '#fff', '#ffffff', 'black', 'white'].includes(v)) {
    die(`logo-mark.svg carries a colour (${v})`);
  }
}

const stamp = (s) => s
  .split('{{HOLDERMAP_JS}}').join(holderJs)
  .split('{{HOLDERMAP_CSS}}').join(holderCss)
  .split('{{VERSION}}').join(VERSION)
  .split('{{ENGINE_VERSION}}').join(ENGINE_VERSION)
  .split('{{BUILT_AT}}').join(BUILT_AT)
  .split('{{LOGO_SVG}}').join(logoSvg)
  .split('{{CHAINS_JSON}}').join(JSON.stringify(CHAINS))
  .split('{{CHAIN_NAMES}}').join(CHAINS.map((c) => c.name.toLowerCase()).join(' &middot; '));

const banner = `/* DiDo for Blockscout v${VERSION} -- analysis engine ENGINE_VERSION ${ENGINE_VERSION}.
   Built ${BUILT_AT} by web/build.mjs from web/src and web/vendor. */
`;
// One IIFE: the engine declares `const DD` at its top level; the app is its own
// strict-mode function receiving DD, with the holder map stamped inside it.
const js = banner + '(function () {\n' + engine + '\n/* ---- dido app ---- */\n' + stamp(read(SRC, 'dido.js')) + '\n})();\n';
if (!js.includes(engine)) die('the vendored engine was altered during bundling');
if (!js.includes(holderJs)) die('the holder map was altered during bundling');
// The page ships under style-src 'self': an inline style attribute would be dropped.
if (/\sstyle="/.test(holderJs)) die('src/holdermap.js emits an inline style attribute');
const css = stamp(read(SRC, 'dido.css'));
if (!css.includes(holderCss)) die('holder-map CSS was altered during bundling');
const html = stamp(read(SRC, 'dido.html'));
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html) || /<style[\s>]/i.test(html) || /\sstyle\s*=/i.test(html)) {
  die('index.html carries inline script or style; the CSP would drop it');
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'dido.js'), js);
writeFileSync(join(DIST, 'dido.css'), css);
writeFileSync(join(DIST, 'index.html'), html);
writeFileSync(join(DIST, 'manifest.json'), JSON.stringify({
  name: 'dido-for-blockscout', version: VERSION, engine_version: ENGINE_VERSION, built_at: BUILT_AT,
}, null, 2) + '\n');
console.log(`web: dido v${VERSION} built (engine ${ENGINE_VERSION}) -> dist/web`);
