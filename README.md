# DiDo for Blockscout

**Who really holds a token?** Paste a token and DiDo draws its top holders as a
map, links the wallets that belong together, marks the deployer, its insiders
and the launch snipers, and opens any wallet into its own portfolio. A token
with 2,000 holders can turn out to be twelve people.

Every holder, cluster, wallet and token fact comes from the
[Blockscout PRO API](https://dev.blockscout.com), read by this repo's own
server. The only other data is the price chart, which the viewer's browser
reads from DexScreener and GeckoTerminal.

Built for the [Blockscout PRO API Buildathon](https://craftora.tech/sprints/blockscout-pro-api-buildathon/)
by the team behind [DigitalDon](https://digitaldon.net). DiDo is DigitalDon's
terminal; this repository is its stand-alone discovery edition: the holder
map, the wallet journey and the chart, with no trading and no dependency on
DigitalDon's own backend.

Chains: **Ethereum, Base, Arbitrum One, Robinhood Chain**.

## What you can do

- **See who holds it.** The top 64 holders as bubbles sized by their share of
  supply, the liquidity pools as one LP bubble, burn addresses left out.
- **See who belongs together.** Holders linked into clusters by how they were
  funded (below), each cluster with its share, its funder and the evidence
  behind it.
- **See the insiders and the snipers.** Role rings on the map: the deployer,
  wallets the deployer funded, wallets that bought in the launch block
  (bundles) or within a minute of it (snipers), and fresh wallets.
- **Follow a wallet.** Click any holder: its portfolio across all four chains
  opens beside the map, and any token it holds opens as its own map. Every
  wallet is one click from its page on Blockscout.
- **Read the chart.** Price, with the analysis engine's entry and exit zones
  drawn on it, and the holders' funding replayed on the time axis.
- **Keep a watchlist**, kept in your browser only.

## How it uses Blockscout

All reads go through one client (`src/blockscout/client.ts`) with one rate
gate for the whole process, retries on 429/5xx, and an honest
`ok / absent / error` answer, so an outage never shows up as "no holders".

| What DiDo shows | Blockscout PRO API call |
|---|---|
| Token name, decimals, supply, holder count, USD price | `GET /{chainId}/api/v2/tokens/{token}` |
| Top holders, with names, tags and contract flags | `GET /{chainId}/api/v2/tokens/{token}/holders` (keyset pages) |
| The deployer and the creation transaction | `GET /{chainId}/api/v2/addresses/{token}` → `creator_address_hash`, `creation_transaction_hash` |
| The creation block (where the launch read starts) | `GET /{chainId}/api/v2/transactions/{hash}` |
| Launch: bundles and snipers | `GET /v2/api?module=logs&action=getLogs` (Transfer events from the creation block) |
| Who funded each holder, and every wallet it traded coin with | `GET /v2/api?module=account&action=txlist` (and `txlistinternal` when no plain transfer funded it), oldest first |
| Whether a shared funder is infrastructure | `GET /{chainId}/api/v2/addresses/{funder}/counters` |
| A wallet's native balance, ENS, name and tags | `GET /{chainId}/api/v2/addresses/{wallet}` |
| A wallet's tokens and their USD value | `GET /{chainId}/api/v2/addresses/{wallet}/token-balances` |
| A wallet's transaction count | `GET /{chainId}/api/v2/addresses/{wallet}/counters` |
| A wallet's NFTs | `GET /{chainId}/api/v2/addresses/{wallet}/nft` |

One key covers all four chains through the multichain gateway
(`api.blockscout.com/{chainId}/...`). Addresses link to each chain's
Blockscout explorer: eth, base, arbitrum and robinhoodchain `.blockscout.com`.

```
browser ──── DiDo page (map, chart, wallet pane)
   │  prices + candles: DexScreener / GeckoTerminal (in the browser)
   │
   └── this server ── /api/holder-intel, /api/wallet-scan, /api/token-tint, ...
            │
            └── Blockscout PRO API (one key, one rate gate, every chain)
```

A first look at a token costs about 60–120 Blockscout requests, roughly
15–30 seconds behind the rate gate; the map shows the holders within seconds
and the clusters join it when the walk is done, with a progress line in
between. Funding traces are cached per wallet and shared across tokens, and
a finished map is cached for 10 minutes.

## How wallets get linked

For the top 50 holders that are people (pools, burn addresses and named
contracts are set aside), DiDo reads each wallet's **oldest** 20 transactions:
where its first coin came from, and every wallet it exchanged native coin with
early on. Then it links holders, strongest evidence first:

| Link | Meaning |
|---|---|
| **direct transfer** | one holder sent native coin straight to another |
| **funded by deployer** | the token's deployer paid this holder |
| **shared funder** | both were paid by the same wallet, and that wallet is not infrastructure |
| **same block** | one sender paid them in the same block (a batch) |
| **identical amounts** | one sender paid 3+ of them the exact same, non-round amount, to the wei |
| **funded together** | one sender paid 3+ of them within 5 minutes |

The rules that keep the map honest:

- **Infrastructure doesn't link.** Half a chain is funded by the same exchange
  or bridge, so "both came from Coinbase" proves nothing. A sender with 2,000+
  lifetime transactions is infrastructure and shares no cluster, unless it
  paid them in one block, in identical odd amounts, or minutes apart: that is
  a batch someone sent. A sender whose count can't be read is not linked on.
- **Round amounts aren't a fingerprint.** 0.01 ETH is what thousands of
  strangers withdraw; 0.0137264 ETH is not.
- **Some holders never link on coin flows.** Named contracts and *sinks*
  (wallets paid by 8+ different senders: deposit addresses, treasuries) would
  wire unrelated people together.
- A wallet's first-transaction counterparty is shown when nothing else funded
  it, but never used as a link. Clusters held together only by timing or
  amounts are marked *weak*.

**Roles.** *dev* is the deployer; *insider* a holder the deployer funded;
*bundle* bought in the first block that traded (the first transfer out of a
pool); *sniper* bought within 60 seconds after it; *fresh* has fewer than 10
transactions in its whole history. A signal that could not be measured (no
pool found in the launch logs, say) is reported as unknown, never as zero.

## API

```
GET /health                                    {"ok":true,"version":"..."}
GET /api/chains                                supported chains
GET /api/token/:chain/:address                 token + top holders
GET /api/clusters/:chain/:address              the raw analysis: traces, clusters, links, launch
GET /api/holder-intel?token&chain&stage=base   the map's first answer (holders, LP share)
GET /api/holder-intel?token&chain&stage=full   + clusters, links, roles, launch signals
GET /api/holder-progress?token&chain           how far a running walk has got
GET /api/wallet-scan?address                   a wallet across every chain
GET /api/token-tint?u=<logo url>               the token's colours, for the background
GET /api/most-scanned                          tokens mapped here in the last 24 h
```

Uncached cluster walks are limited to 6 per minute per IP, wallet scans to 10.

## Run it

Requires Node 22+ and a Blockscout PRO API key from
[dev.blockscout.com](https://dev.blockscout.com).

```bash
npm install
cp .env.example .env        # put your key in BLOCKSCOUT_API_KEY
npm run build               # the server and the page
npm start                   # http://localhost:3000
```

The key lives only in `.env` locally (gitignored) or in your host's
environment variables. On **Railway**: create a service from this repo
(`railway.toml` and the `Dockerfile` are picked up), then set
`BLOCKSCOUT_API_KEY` under the service's *Variables*. Railway injects `PORT`.
Without a key the page and the chart still run and the map says it is off.

Tests run offline against a scripted Blockscout and need no key:

```bash
npm test
```

## Layout

```
src/                     the server (TypeScript, Fastify)
  blockscout/            the Blockscout PRO API client and its reads
  clusters.ts            linking holders (pure, tested rule by rule)
  holders.ts             the map's payload, built from the analysis
  wallet.ts              the cross-chain wallet scan
  tint.ts                logo colours
  web.ts                 the page, under a strict Content-Security-Policy
web/src/                 the DiDo page, stylesheet and app
web/vendor/              DigitalDon's analysis engine and holder map (see SOURCE.md)
web/build.mjs            bundles the page into dist/web
test/                    node:test suites
```

## Roadmap

**Sprint 1 (MVP, Oct 8–21)**
- [x] Blockscout PRO client: rate gate, retries, honest empty states
- [x] Funder tracing, deployer, clusters
- [x] Launch signals (bundles, snipers) from Transfer logs
- [x] The DiDo map, chart and wallet journey on this server
- [ ] Live deployment and demo

**Sprint 2 (Oct 25–31)**: token security from the verified contract
(mint, owner, proxy), cost basis in the wallet pane, more chains, and
whatever the Sprint 1 feedback asks for.

Not financial advice.
