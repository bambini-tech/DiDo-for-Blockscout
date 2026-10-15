# DiDo for Blockscout

**Who really holds a token?** Paste a token and DiDo draws its top holders as a
map, links the wallets that belong together, marks the deployer, its insiders
and the launch snipers, and opens any wallet into its own portfolio. A token
with 2,000 holders can turn out to be twelve people.

Every holder, cluster, wallet and token fact comes from the
[Blockscout PRO API](https://dev.blockscout.com), read by this repo's own
server. Market data (which tokens are moving, their prices and candles) comes
from DexScreener and GeckoTerminal, because that is the one thing an explorer
does not carry: the price chart reads it in the viewer's browser, the start
page's entry board on the server.

Built for the [Blockscout PRO API Buildathon](https://craftora.tech/sprints/blockscout-pro-api-buildathon/)
by the team behind [DigitalDon](https://digitaldon.net). DiDo is DigitalDon's
terminal; this repository is its stand-alone discovery edition: the holder
map, the wallet journey and the chart, with no trading and no dependency on
DigitalDon's own backend.

**17 chains**: every mainnet the Blockscout PRO API serves that DexScreener and
GeckoTerminal also cover ([list](#chains)), from Ethereum, Base and Arbitrum to
Polygon, OP Mainnet, Celo, Scroll, ZKsync, Unichain, Robinhood Chain and Arc.

## What you can do

- **Start from the board.** The start page is DiDo's own: a garden of every
  token the server read in its last round, the picks lit (at their entry,
  near it, or at support, sized by liquidity and placed by room to the sell
  level), what is running hot right now, and the tokens mapped here lately.
  Hover any bubble to see why it was picked or let go.
- **See who holds it.** The top 64 holders as bubbles sized by their share of
  supply, the liquidity pools as one LP bubble, burn addresses left out.
- **See who belongs together.** Holders linked into clusters by how they were
  funded (below), each cluster with its share, its funder and the evidence
  behind it.
- **See the insiders and the snipers.** Role rings on the map: the deployer,
  wallets the deployer funded, wallets that bought in the launch block
  (bundles) or within a minute of it (snipers), and fresh wallets.
- **Follow a wallet.** Click any holder: its portfolio across all 17 chains
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
| The board's holder check (top 10 share) for every pick | `GET /{chainId}/api/v2/tokens/{token}` + `/holders` |

One key covers all 17 chains through the multichain gateway
(`api.blockscout.com/{chainId}/...`), and every address links to its chain's
Blockscout explorer.

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

## Chains

DiDo runs on every **mainnet the Blockscout PRO API serves** (60 at the last
check) **that DexScreener and GeckoTerminal also cover**: holders and wallets
need Blockscout, finding and charting a token needs the other two. That is
17 chains today:

| Chain | Chain id | DexScreener | GeckoTerminal | Gas | Explorer |
|---|---|---|---|---|---|
| Ethereum | 1 | `ethereum` | `eth` | ETH | [eth.blockscout.com](https://eth.blockscout.com) |
| Arbitrum One | 42161 | `arbitrum` | `arbitrum` | ETH | [arbitrum.blockscout.com](https://arbitrum.blockscout.com) |
| Arc | 5042 | `arc` | `arc` | USDC | [explorer.arc.io](https://explorer.arc.io) |
| Base | 8453 | `base` | `base` | ETH | [base.blockscout.com](https://base.blockscout.com) |
| Celo | 42220 | `celo` | `celo` | CELO | [celo.blockscout.com](https://celo.blockscout.com) |
| Flow EVM | 747 | `flowevm` | `flow-evm` | FLOW | [evm.flow.com](https://evm.flow.com) |
| Fuse | 122 | `fuse` | `fuse` | FUSE | [explorer.fuse.io](https://explorer.fuse.io) |
| Ink | 57073 | `ink` | `ink` | ETH | [explorer.inkonchain.com](https://explorer.inkonchain.com) |
| MegaETH | 4326 | `megaeth` | `megaeth` | ETH | [megaeth.blockscout.com](https://megaeth.blockscout.com) |
| OP Mainnet | 10 | `optimism` | `optimism` | ETH | [explorer.optimism.io](https://explorer.optimism.io) |
| Polygon | 137 | `polygon` | `polygon_pos` | POL | [polygon.blockscout.com](https://polygon.blockscout.com) |
| Robinhood Chain | 4663 | `robinhood` | `robinhood` | ETH | [robinhoodchain.blockscout.com](https://robinhoodchain.blockscout.com) |
| Scroll | 534352 | `scroll` | `scroll` | ETH | [scrollscan.com](https://scrollscan.com) |
| Soneium | 1868 | `soneium` | `soneium` | ETH | [soneium.blockscout.com](https://soneium.blockscout.com) |
| Unichain | 130 | `unichain` | `unichain` | ETH | [unichain.blockscout.com](https://unichain.blockscout.com) |
| World Chain | 480 | `worldchain` | `world-chain` | ETH | [worldchain-mainnet.explorer.alchemy.com](https://worldchain-mainnet.explorer.alchemy.com) |
| ZKsync Era | 324 | `zksync` | `zksync` | ETH | [zksync.blockscout.com](https://zksync.blockscout.com) |

The list lives in one file, `data/chains.json`, read by the server, the
board, the wallet scan and the page. No id in it was guessed: for each chain
a GeckoTerminal pool was looked up on DexScreener under that chain's id and
had to come back as the same pool, with candles. `npm run verify-chains`
re-runs that check against live data (no key needed), and
`npm run verify-chains -- --candidates` lists the Blockscout mainnets that
are not in the file yet.

Left out, for now, because DexScreener does not index them (Blockscout
does): Gnosis, Ronin, ZetaChain, Mode, Lisk, Astar, Rootstock, Etherlink,
Immutable zkEVM, IOTA EVM, Zilliqa, Filecoin EVM, Plume, Shape, Arbitrum Nova
and a few younger chains. The remaining PRO API mainnets have no
GeckoTerminal market yet, so there would be no candles to chart.

## The entry board

Every 4 hours the server reads the tokens that are moving on all 17
chains (GeckoTerminal's trending and top-volume pools, DexScreener's boosts,
profiles and community takeovers) and runs each through three stages, the
same ones DiDo's start page shows:

1. **solid**: a real pool. Logo and info on its pool, liquidity at least
   $30k, 2+ days old, $25k+ daily volume, liquidity at least 1% of market
   cap, trading both ways, a day's volume under 25x its pool, 150+ trades.
2. **at entry**: the analysis engine (the same one that draws the chart's
   zones) reads its hourly candles. Kept when price is in a buy zone (or
   within 5% above it) with room to the sell level (12% for a day trade, 25%
   for weeks) and a score of 55+; a score of 45-54 in the zone is shown as
   *at support*.
3. **clean holders**: Blockscout's holder list. Let go when the top 10
   wallets (pools and burn addresses aside) hold more than half.

Everything read and let go stays in the garden, faint, with the stage and
the reason. A round reads at most 60 tokens' candles (`BOARD_MAX_READS`) at
one request every 4 s, so it takes a few minutes; the board shows the last
round until the next one lands.

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
GET /api/board                                 the entry board: picks, running hot, everything let go
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
- [x] DiDo's start page: the entry board, the garden, running hot
- [ ] Live deployment and demo

**Sprint 2 (Oct 25–31)**: token security from the verified contract
(mint, owner, proxy), cost basis in the wallet pane, more chains, and
whatever the Sprint 1 feedback asks for.

Not financial advice.
