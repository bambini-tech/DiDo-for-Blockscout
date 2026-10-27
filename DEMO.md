# The demo: one investigation, start to finish

The demo follows one token from the start page to a single wallet's history,
and checks every claim on the way in Blockscout Explorer. The token is
**Chainlink (LINK) on Ethereum**, the token the judges tested in Sprint 1:
it has an exchange cluster to label, multisigs funded with the token itself,
and a well-known history anyone can verify.

Live: https://dido-for-blockscout.up.railway.app

## 1. Open the token (0:00)

Paste `0x514910771AF9Ca656af840dff83E8264EcF986CA` into the search, or open
`/?c=ethereum&t=0x514910771AF9Ca656af840dff83E8264EcF986CA`.

- The holders appear within seconds: the top 64 as bubbles sized by their
  share of supply, read from Blockscout's holder list.
- The trail at the top reads *start → $LINK*. Its **Blockscout ↗** button
  opens the token's page on eth.blockscout.com. Say: *every number on this
  map is one click from its source.*

## 2. Read the map (0:30)

While the clusters are mapped, the progress line counts the funding traces.
When they land:

- Hover a big bubble. The tooltip names it from Blockscout's tags, for
  example *Binance: Hot Wallet 20 · exchange*.
- The cluster cards on the left name each group. One reads **Binance ·
  exchange**: Blockscout labels its wallets as Binance's, so DiDo shows it as
  exchange custody and leaves it out of the bubble-risk verdict.

## 3. Open the token-funded cluster (1:00)

Click the cluster of multisigs (each holds about 3% of supply).

- **Wallets** tab: the Safe multisigs, each with its Blockscout label where
  one exists (*Chainlink: Noncirculating Supply 3*) and a ↗ to its page.
- **Evidence** tab: why they are one group. Each line names the shared
  sender and the asset, *funded with $LINK by the same sender* and *within
  minutes of each other*, with a **tx ↗** link for every funding transaction.
  Say: *no ETH ever moved between these wallets; they were grouped on the
  token itself, which Sprint 1 could not do.*

## 4. Follow the funder (1:45)

In the evidence list, click the funder's ↗.

- Blockscout opens the sender's address page: its transfers of LINK to each
  multisig on the same day, minutes apart. The map's claim, checked at the
  source.
- Back in DiDo, click one funding **tx ↗**: the transaction page shows the
  exact LINK amount sent to that multisig.

## 5. One member's wallet journey (2:30)

Click one multisig bubble, then **open wallet →** on its card.

- The card first: its share, what it holds, **funded by** the sender with the
  transaction, and **open in Blockscout ↗**.
- The wallet pane opens beside the map: the wallet across all 17 chains,
  found through Blockscout's multichain aggregator, with what it holds and,
  where its history allows, what each position cost.
- The trail now reads *start → $LINK → 0x…*. Click any token the wallet holds
  to map that token next, or step back along the trail.

## 6. Close (3:15)

- Back on the start page, the garden: tokens the board read this round, the
  picks lit, everything let go with its reason.
- One line to end on: *DiDo reads Blockscout for every holder, wallet and
  label, and every claim it makes opens in Blockscout Explorer.*

## What to say about what is new

The cluster method and the holder map come from DigitalDon's analyzer
(already public). Built for the buildathon: the Blockscout server, the wallet
scan inside DiDo, the trail, the watchlist and the garden in Sprint 1; the
Blockscout labels, explorer links on every claim, and token-funded clusters
in Sprint 2. See [Built for the buildathon](README.md#built-for-the-buildathon).
