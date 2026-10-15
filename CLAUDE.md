# CLAUDE.md -- DiDo for Blockscout

Instructions for any AI/agent session working on this repo.

## What this is

A **public** hackathon entry (Blockscout PRO API Buildathon, Oct 8 - Nov 3
2026): DiDo's discovery edition -- the holder map, clusters, wallet journey
and chart -- with every holder, wallet and token fact read from the
Blockscout PRO API by this repo's own server. It is a stand-alone project,
separate from DigitalDon's private monorepo and from the DiDo that ships
there (which has its own backend and trading). Nothing here is read by
DigitalDon and nothing flows back automatically.

Layout: `src/` the server (Fastify, TypeScript), `web/src/` the DiDo page,
`web/vendor/` DigitalDon's engine and holder map, `web/build.mjs` the bundle.

## Rules

- **Public repo.** Never commit an API key, a `.env`, internal hostnames, or
  anything from DigitalDon's private code that is not meant to be public.
  Write the code here fresh; do not paste the private bot's source.
- **Blockscout is the only source of holder, wallet and token facts.**
  Judging weights the Blockscout integration at 30%. Market data (which
  tokens move, prices, candles) is the one exception, from DexScreener and
  GeckoTerminal: in the browser for the chart, on the server only for the
  entry board (`src/market/`, paced, 429 backoff). Never read holders,
  wallets or token info anywhere else, and add no other provider.
- **`web/vendor/` is never edited here.** It is a byte-for-byte snapshot
  (`web/vendor/SOURCE.md`); the build and `test/web.test.mjs` check it.
  Adapt DiDo in `web/src/`.
- **Chains live in `data/chains.json` only.** The server, board, wallet scan
  and page (stamped by `web/build.mjs`) all read it; never hand-keep a chain
  list anywhere else. A chain is added only when it is a Blockscout PRO API
  mainnet AND `npm run verify-chains` proves its DexScreener and
  GeckoTerminal ids with live data. Never guess an id: a wrong one reads as
  "no holders", indistinguishable from an outage.
- **The page has nothing inline** (no inline script, style or `style=`): it
  ships under `script-src 'self'` / `style-src 'self'`.
- **No trading, no accounts.** This edition is discovery only.
- **The start page is DiDo's own.** It reads `/api/board` in the bot's
  board shape (`src/board/read.ts`); keep let-go reasons inside the set the
  page words (`reasonText` in `web/src/dido.js`).
- **Never log the API key.** It travels as a query parameter, so never log or
  return a request URL as-is.
- **"Absent" is not "error".** Keep the client's `ok / absent / error`
  distinction all the way to the UI; an outage must never render as "no
  holders" or "no clusters".
- **Respect the rate gate.** Every request goes through `BlockscoutClient`;
  never call `fetch` on Blockscout directly.
- **The key is on the builder plan** (15 req/s, 100M credits a month; plan
  settings in `src/blockscout/credits.ts`, `BLOCKSCOUT_PLAN=free` for the
  free tier). Blockscout bills per request, not per row: read deep pages in
  one request rather than many small ones, cache what cannot change, and
  stay on 20-credit routes unless a pricier one replaces several requests.
  Every request is charged on the `CreditLedger`; `/health` shows the day.
- **Brand is monochrome** (ink on paper, emphasis by opacity), as in
  DigitalDon. The only colour: the holder map's role tints, and the token's
  own logo colours in the frosted background (never on text or data).
- Run `npm test` before every push. Bump `VERSION` and `package.json` together.
- The key: `.env` locally (gitignored), the host's environment variables in
  production (Railway: the service's Variables). Never in a file in the repo.
