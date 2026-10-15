# Vendored from DigitalDon

These files are a snapshot of DigitalDon's shared analysis engine and holder
map, taken so this repository builds and runs on its own.

| File | What it is | Taken from |
|---|---|---|
| `engine.js` | The analysis engine (TA score, zones, trade plan), `ENGINE_VERSION` 1.29.0 | DigitalDon Web Analyzer, ENGINE block |
| `holdermap.js` | The interactive holder map and its dossier panel | DigitalDon Web Analyzer, HOLDERMAP block |
| `holdermap.css` | The holder map's stylesheet | DigitalDon Web Analyzer, HOLDERMAP-CSS block |
| `logo-mark.svg` | The DigitalDon mark (monochrome) | DigitalDon website assets |
| `ENGINE_VERSION` | The engine's contract version | DigitalDon |

The app around them (`web/src/`) started from DiDo 0.32.0 and was adapted
for this edition: Blockscout chains only, this repo's server as the API, no
trading.

**Do not edit these files here.** They are kept byte-for-byte so a later
refresh is a plain copy, and `web/build.mjs` checks that they survive
bundling unchanged. Fixes to the engine or the map belong upstream.
