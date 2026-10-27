/**
 * Blockscout results in the shape DiDo's holder map reads (the payload of
 * `GET /api/holder-intel`, stage `base` and stage `full`).
 *
 * The map draws: one bubble per top holder sized by % of supply, one LP bubble
 * for the pools, clusters as hulls with their links, per-wallet role rings
 * (dev, insider, sniper, bundle, fresh), a funding replay on the time axis, and
 * a summary line (bubble risk, snipers, bundles, insiders, fresh wallets).
 * Every number here is computed from Blockscout data; a signal that was not
 * measured is null, never 0.
 */
import type { TokenResponse, ClusterResponse } from './service.js';
import type { Holder } from './blockscout/tokens.js';
import type { Buy } from './blockscout/launch.js';
import type { Reason } from './clusters.js';
import { classify } from './classify.js';
import { labelsOf } from './labels.js';

/** Bubbles on the map. */
export const TOP_OWNERS = 64;
/** Groups the map draws (cluster letters A..E). */
export const MAP_CLUSTERS = 5;
/** A wallet with fewer plain transactions than this in its whole life is "fresh". */
export const FRESH_MAX_TXS = 10;

export interface Owner {
  address: string;
  pct: number;
  rank: number;
  roles?: string[];
  first_ts?: number;
  fund_ts?: number;
  kind?: 'contract' | 'multisig' | 'sink';
  /** A group member ranked below the top rows, drawn with its group. */
  beyond?: boolean;
  /** Who it is, from Blockscout's name and tags ("Binance: Hot Wallet 20"). */
  label?: string;
  /** The owner behind the label ("Binance"). */
  entity?: string;
  /** Blockscout tags it as an exchange wallet. */
  exchange?: true;
  funder?: string;
  funding_kind?: string | null;
  fund_tx?: string;
  funder_label?: string;
}

/** Blockscout's name and tags on an owner row. */
function withLabels(o: Owner, h: Holder | undefined): Owner {
  if (!h) return o;
  const l = labelsOf(h.name, h.tags);
  return { ...o, ...(l.label ? { label: l.label } : {}), ...(l.entity ? { entity: l.entity } : {}), ...(l.exchange ? { exchange: true as const } : {}) };
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const pctOf = (h: Holder) => round(h.share ?? 0, 4);

/** The holders that are people: pools and burn addresses left out, in rank order. */
function split(tok: TokenResponse, pair?: string | null) {
  const { pools, burn } = classify(tok.holders, pair);
  return { pools, burn, people: tok.holders.filter((h) => !pools.has(h.address) && !burn.has(h.address)) };
}

/**
 * The rows the map draws: the top holders, then every member of a drawn group
 * that ranks below them, in rank order and flagged `beyond`. The walk traces
 * more holders than the map has bubbles, so without these a group of wallets
 * at ranks 40 and 80 would read "2 wallets" with one drawn and its link
 * dropped. Their share is already in the holder list: no extra request.
 */
export function mapRows(tok: TokenResponse, clusters: { members: string[] }[], pair?: string | null): Owner[] {
  const { people } = split(tok, pair);
  const rows: Owner[] = people.slice(0, TOP_OWNERS).map((h, i) => withLabels({ address: h.address, pct: pctOf(h), rank: i + 1 }, h));
  const drawn = new Set(rows.map((o) => o.address));
  const rankOf = new Map(people.map((h, i) => [h.address, i]));
  const extra = new Map<number, Owner>();
  for (const cl of clusters.slice(0, MAP_CLUSTERS)) {
    for (const m of cl.members) {
      const i = rankOf.get(m);
      if (drawn.has(m) || i === undefined) continue;
      extra.set(i, withLabels({ address: m, pct: pctOf(people[i]!), rank: i + 1, beyond: true }, people[i]));
    }
  }
  return [...rows, ...[...extra.keys()].sort((x, y) => x - y).map((i) => extra.get(i)!)];
}

export function basePayload(tok: TokenResponse, pair?: string | null) {
  const { pools, burn, people } = split(tok, pair);
  const sum = (list: Holder[]) => round(list.reduce((s, h) => s + (h.share ?? 0), 0));
  const top10 = sum(people.slice(0, 10));
  const owners: Owner[] = people.slice(0, TOP_OWNERS).map((h, i) => withLabels({ address: h.address, pct: pctOf(h), rank: i + 1 }, h));
  return {
    token: tok.token.address,
    chain: tok.chain.key,
    /** The chain's Blockscout explorer: every address, transaction and the token open there. */
    explorer: tok.chain.explorer,
    /** The chain's gas coin, for the evidence wording ("sent ETH"). */
    native: tok.chain.native,
    stage: 'base' as const,
    source: 'blockscout',
    symbol: tok.token.symbol,
    name: tok.token.name,
    holder_count: tok.token.holderCount,
    holder_count_capped: false,
    analyzed: people.length,
    owner_level: true,
    top_owners: owners,
    top10_pct: top10,
    top20_pct: sum(people.slice(0, 20)),
    largest_wallet_pct: round(people[0]?.share ?? 0),
    concentration: top10 >= 50 ? 'High' : top10 >= 25 ? 'Mid' : 'Low',
    whales: people.filter((h) => (h.share ?? 0) >= 1).length,
    mids: people.filter((h) => (h.share ?? 0) >= 0.1 && (h.share ?? 0) < 1).length,
    lows: people.filter((h) => (h.share ?? 0) < 0.1).length,
    quality_note: null,
    lp_pct: sum(tok.holders.filter((h) => pools.has(h.address))),
    burn_pct: sum(tok.holders.filter((h) => burn.has(h.address))),
    // Honeypot, tax and mint authority are not read from Blockscout yet: the
    // strip stays hidden rather than show a guess.
    security: null,
    partial: tok.partial,
    as_of: Math.floor(Date.parse(tok.fetchedAt) / 1000),
  };
}

/** The links the map draws, by kind: a direct transfer, a holder that funded another, or a shared funder. */
const STRONG: Reason[] = ['direct transfer', 'funded by deployer', 'shared funder', 'same block'];

export function fullPayload(c: ClusterResponse, pair?: string | null) {
  const base = basePayload(c, pair);
  const a = c.analysis;
  const supply = BigInt(c.token.totalSupply || '0');
  const shareOfRaw = (raw: string) => (supply > 0n ? Number((BigInt(raw) * 1_000_000n) / supply) / 10_000 : 0);
  const deployer = c.deployer.address;

  const bundles = new Set(c.launch.bundles.map((b) => b.buyer));
  const snipers = new Set(c.launch.snipers.map((b) => b.buyer));
  const contracts = new Set(c.holders.filter((h) => h.isContract).map((h) => h.address));
  const holderBy = new Map(c.holders.map((h) => [h.address, h]));
  /** Who an address is: a holder's own name and tags, or the label read for a funder or the deployer. */
  const whoIs = (addr: string | null) => {
    if (!addr) return null;
    const h = holderBy.get(addr) ?? c.labels?.[addr];
    if (!h) return null;
    const l = labelsOf(h.name, h.tags);
    return l.label ? l : null;
  };

  const owners: Owner[] = mapRows(c, a.clusters, pair).map((o) => {
    const w = a.wallets[o.address];
    const roles: string[] = [];
    if (o.address === deployer) roles.push('dev');
    if (w?.deployerFunded && o.address !== deployer) roles.push('insider');
    if (snipers.has(o.address)) roles.push('sniper');
    if (bundles.has(o.address)) roles.push('bundle');
    if (w?.trace === 'ok' && w.fresh) roles.push('fresh');
    const out: Owner = { ...o, roles };
    if (w?.firstTs) out.first_ts = w.firstTs;
    if (w?.fundTs) out.fund_ts = w.fundTs;
    // Who funded it and with which transaction: one click to the proof on Blockscout.
    if (w?.funder) {
      out.funder = w.funder;
      out.funding_kind = w.fundingKind;
      if (w.fundTx) out.fund_tx = w.fundTx;
      const who = whoIs(w.funder);
      if (who?.label) out.funder_label = who.label;
    }
    if (w?.sink) out.kind = 'sink';
    else if (contracts.has(o.address)) out.kind = labelsOf(holderBy.get(o.address)?.name ?? null, holderBy.get(o.address)?.tags ?? []).wallet ? 'multisig' : 'contract';
    return out;
  });
  const drawn = new Set(owners.map((o) => o.address));

  const ownerBy = new Map(owners.map((o) => [o.address, o]));
  const clusters = a.clusters.map((cl) => {
    const vias = a.links.filter((l) => l.via && cl.members.includes(l.a)).map((l) => l.via!);
    const funder = mostCommon(vias);
    const strong = cl.reasons.some((r) => STRONG.includes(r));
    // Who the group is, when Blockscout says so: the entity its labelled
    // members share ("Binance"), and whether they are all exchange wallets.
    const named = cl.members.map((m) => ownerBy.get(m) ?? withLabels({ address: m, pct: 0, rank: 0 }, holderBy.get(m))).filter((o) => o.label);
    const entities = new Set(named.map((o) => o.entity ?? o.label));
    const mostlyNamed = named.length * 2 >= cl.members.length;
    const label = mostlyNamed && entities.size === 1 ? [...entities][0]! : null;
    const exchange = mostlyNamed && named.every((o) => o.exchange);
    const funderWho = whoIs(funder);
    return {
      pct: round(cl.share),
      wallets: cl.members.length,
      reason: cl.reasons.join(' · ') + (cl.tokenLinked ? ` · in ${c.token.symbol ?? 'the token'}` : ''),
      members: cl.members,
      funder,
      funder_is_holder: Boolean(funder && drawn.has(funder)),
      /** Blockscout's label for the funder ("Chainlink: Deployer"). */
      funder_label: funderWho?.label ?? null,
      evidence: strong ? 'strong' : 'weak',
      weak_reason: strong ? null : 'timing and amounts only',
      owner: null,
      owner_label: null,
      /** The entity Blockscout names for most of its wallets ("Binance"); null when they are unnamed or differ. */
      // No shared name among its wallets: the funder's, when Blockscout has one.
      label: label ?? (exchange ? 'exchange wallets' : funderWho ? `funded by ${funderWho.entity ?? funderWho.label}` : null),
      /** Where the label comes from: the wallets' own tags, or their funder's. */
      label_from: label || exchange ? 'members' : funderWho ? 'funder' : null,
      /** Every named member is an exchange wallet: custody for many users, left out of the bubble-risk verdict. */
      exchange,
      /** Some links are on the token itself (funded with it, not with native coin). */
      token_linked: cl.tokenLinked,
    };
  });

  // One line per pair on the map, of its strongest kind. Each carries what
  // the evidence panel needs to open the proof on Blockscout: the reason, the
  // transaction, the sender behind a group link, and the asset it moved.
  const RANK: Record<string, number> = { transfer: 0, funder: 1, shared_funder: 2 };
  type MapLink = { source: string; target: string; kind: string; reason: Reason; tx?: string; tx_a?: string; via?: string; asset?: 'token' };
  const byPair = new Map<string, MapLink>();
  for (const l of a.links
    .filter((l) => drawn.has(l.a) && drawn.has(l.b))
    .map((l): MapLink => {
      const extra = { reason: l.reason, ...(l.tx ? { tx: l.tx } : {}), ...(l.txA ? { tx_a: l.txA } : {}), ...(l.via ? { via: l.via } : {}), ...(l.asset ? { asset: l.asset } : {}) };
      if (l.reason === 'direct transfer') return { source: l.a, target: l.b, kind: 'transfer', ...extra };
      if (l.reason === 'funded by deployer' && (l.a === deployer || l.b === deployer)) {
        // A holder funded by another holder: source is the funded wallet, target its funder.
        return { source: l.a === deployer ? l.b : l.a, target: deployer, kind: 'funder', ...extra };
      }
      return { source: l.a, target: l.b, kind: 'shared_funder', ...extra };
    })) {
    const key = [l.source, l.target].sort().join('|');
    const prev = byPair.get(key);
    if (!prev || RANK[l.kind]! < RANK[prev.kind]!) byPair.set(key, l);
  }
  const links = [...byPair.values()];

  /** Every label the map can show for an address it names but does not draw (funders, the deployer). */
  const nameOf: Record<string, string> = {};
  for (const addr of [deployer, ...clusters.map((cl) => cl.funder)]) {
    const who = whoIs(addr ?? null);
    if (addr && who?.label) nameOf[addr] = who.label;
  }

  // The summary counts the top holders, as before; group wallets drawn from
  // below them do not change "fresh" or "insider" shares of the top list.
  const top = owners.filter((o) => !o.beyond);
  const sumPct = (pred: (o: Owner) => boolean) => round(top.filter(pred).reduce((s, o) => s + o.pct, 0), 1);
  const has = (r: string) => (o: Owner) => Boolean(o.roles?.includes(r));
  const launchPct = (buys: Buy[]) => round(buys.reduce((s, b) => s + shareOfRaw(b.raw), 0), 1);
  const measured = c.launch.measured;
  // Exchange custody is many users' coins in one place, not one hand: it is
  // drawn and labelled, and left out of the bubble-risk verdict.
  const judged = clusters.filter((cl) => !cl.exchange);
  const clusteredPct = round(judged.reduce((s, cl) => s + cl.pct, 0), 1);
  const largest = judged.reduce((m, cl) => Math.max(m, cl.pct), 0);
  const insiderPct = sumPct((o) => has('insider')(o) || has('dev')(o));

  return {
    ...base,
    stage: 'full' as const,
    top_owners: owners,
    clusters,
    links,
    clustered_pct: clusteredPct,
    exchange_pct: round(clusters.filter((cl) => cl.exchange).reduce((s, cl) => s + cl.pct, 0), 1),
    labels: nameOf,
    bubble_risk: clusteredPct >= 20 || largest >= 10 || insiderPct >= 10 ? 'High' : clusteredPct >= 8 ? 'Medium' : 'Low',
    funders_resolved: Object.values(a.wallets).filter((w) => w.trace === 'ok' && w.funder).length,
    reached_n: a.stats.traced,
    traces_failed: a.stats.failed,
    fresh_pct: sumPct(has('fresh')),
    fresh_n: top.filter(has('fresh')).length,
    insider_pct: insiderPct,
    insider_n: top.filter((o) => has('insider')(o) || has('dev')(o)).length,
    dev_found: Boolean(deployer && drawn.has(deployer)),
    deployer,
    sniper_launch_pct: measured ? launchPct(c.launch.snipers) : null,
    sniper_now_pct: measured ? sumPct(has('sniper')) : null,
    sniper_n: measured ? c.launch.snipers.length : null,
    bundle_launch_pct: measured ? launchPct(c.launch.bundles) : null,
    bundle_now_pct: measured ? sumPct(has('bundle')) : null,
    bundle_n: measured ? c.launch.bundles.length : null,
    launch_ts: c.launch.launchTs,
    blockscout_calls: c.calls,
  };
}

function mostCommon(list: string[]): string | null {
  const count = new Map<string, number>();
  for (const x of list) count.set(x, (count.get(x) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [x, k] of count) if (k > n) [best, n] = [x, k];
  return best;
}
