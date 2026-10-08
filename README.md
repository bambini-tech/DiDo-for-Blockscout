# DiDo for Blockscout

**Who really holds a token?** DiDo draws a token's holders as a map and links
the wallets that belong together: wallets funded by the same source, wallets
funded by the deployer, wallets funded in the same block. A token with 2,000
holders can turn out to be twelve people.

Every number comes from the [Blockscout PRO API](https://dev.blockscout.com).
There is no other data source.

Built for the [Blockscout PRO API Buildathon](https://craftora.tech/sprints/blockscout-pro-api-buildathon/)
by the team behind [DigitalDon](https://digitaldon.net). DiDo is DigitalDon's
holder-map terminal; this repository is a stand-alone, open version of it,
written from scratch on Blockscout.

> Status: **Sprint 1, in progress.** The service and the Blockscout client are
> in place; funder tracing, clustering and the map land over the sprint (see
> [Roadmap](#roadmap)).

## How it uses Blockscout

| What DiDo needs | Blockscout PRO API call |
|---|---|
| Token name, decimals, supply, holder count | `GET /{chainId}/api/v2/tokens/{address}` |
| Top holders, with names and public tags | `GET /{chainId}/api/v2/tokens/{address}/holders` (keyset pages) |
| Who deployed the token *(next)* | `GET /{chainId}/api/v2/addresses/{address}` → `creator_address_hash` |
| Who funded each holder *(next)* | `GET /v2/api?module=account&action=txlist` and `txlistinternal`, oldest first |
| Whether a funder is infrastructure *(next)* | `GET /{chainId}/api/v2/addresses/{address}/counters` |

Every address in the UI links to the chain's Blockscout explorer.

### Chains

| Chain | Chain id | Explorer |
|---|---|---|
| Ethereum | 1 | eth.blockscout.com |
| Base | 8453 | base.blockscout.com |
| Arbitrum One | 42161 | arbitrum.blockscout.com |

One key covers all of them through Blockscout's multichain gateway; adding a
chain is one line in `src/chains.ts`.

### Being a good API citizen

- **One rate gate** for the whole process (default 4.5 requests/s, under the
  PRO free tier's 5). However many wallets are being traced at once, requests
  leave evenly spaced.
- **Retries** on 429 / 5xx / network errors, honouring `Retry-After`.
- **Caching and de-duplication**: a token is walked once per minute at most,
  and two people opening the same token share one walk.
- **"Not there" is not "couldn't look".** A 404 from Blockscout and an outage
  produce different answers all the way to the UI, so DiDo never shows an
  empty map when the truth is "we don't know".

## API

```
GET /health                          {"ok":true,"version":"0.1.0"}
GET /api/chains                      supported chains
GET /api/token/:chain/:address       token + top holders with % of supply
```

`/api/token` answers `400` for an unknown chain or malformed address, `404`
when Blockscout has never seen the token on that chain, and `502` when
Blockscout could not be read.

## Run it

Requires Node 22+ and a Blockscout PRO API key from
[dev.blockscout.com](https://dev.blockscout.com).

```bash
npm install
cp .env.example .env        # put your key in BLOCKSCOUT_API_KEY
npm run build
BLOCKSCOUT_API_KEY=... npm start
curl localhost:3000/api/token/eth/0xdAC17F958D2ee523a2206206994597C13D831ec7
```

Tests run offline against a scripted Blockscout and need no key:

```bash
npm test
```

## Roadmap

**Sprint 1 (MVP, Oct 8-21)**
- [x] Service skeleton, Blockscout PRO client (rate gate, retries, honest empty states)
- [x] Token + top holders endpoint, cached
- [ ] Funder tracing for every holder (first inbound transfer, internal transfers)
- [ ] Deployer detection and deployer-funded holders
- [ ] Clusters: shared funder, same-block / same-amount funding, holder-to-holder transfers
- [ ] The holder map: bubbles sized by share, linked by cluster, every address one click from Blockscout
- [ ] Live deployment and demo

**Sprint 2 (Oct 25-31)**: more chains, a cluster dossier per group, and
whatever the Sprint 1 feedback asks for.
