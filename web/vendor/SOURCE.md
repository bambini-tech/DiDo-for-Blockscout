# Vendored from DigitalDon

These files are a snapshot of DigitalDon's shared analysis engine, taken so
this repository builds and runs on its own.

| File | What it is | Taken from |
|---|---|---|
| `engine.js` | The analysis engine (TA score, zones, trade plan), `ENGINE_VERSION` 1.29.0 | DigitalDon Web Analyzer, ENGINE block |
| `logo-mark.svg` | The DigitalDon mark (monochrome) | DigitalDon website assets |
| `ENGINE_VERSION` | The engine's contract version | DigitalDon |

The app around them (`web/src/`) started from DiDo 0.32.0 and was adapted
for this edition: Blockscout chains only, this repo's server as the API, no
trading.

The holder map (`web/src/holdermap.js`, `web/src/holdermap.css`) started as
the same snapshot (DigitalDon Web Analyzer, HOLDERMAP blocks) and moved to
`web/src/` in Sprint 2: this edition's fork adds Blockscout labels on every
holder, funder and cluster, "open in Blockscout" links on every address,
transaction and the token, and evidence that names the asset and the
transaction behind each link.

**Do not edit these files here.** They are kept byte-for-byte so a later
refresh is a plain copy, and `web/build.mjs` checks that they survive
bundling unchanged. Fixes to the engine or the map belong upstream.
