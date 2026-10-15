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

/** Bubbles on the map. */
export const TOP_OWNERS = 64;
/** A wallet with fewer plain transactions than this in its whole life is "fresh". */
export const FRESH_MAX_TXS = 10;

export interface Owner {
  address: string;
  pct: number;
  rank: number;
  roles?: string[];
  first_ts?: number;
  fund_ts?: number;
  kind?: 'contract' | 'sink';
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const pctOf = (h: Holder) => round(h.share ?? 0, 4);

export function basePayload(tok: TokenResponse, pair?: string | null) {
  const { pools, burn } = classify(tok.holders, pair);
  const people = tok.holders.filter((h) => !pools.has(h.address) && !burn.has(h.address));
  const sum = (list: Holder[]) => round(list.reduce((s, h) => s + (h.share ?? 0), 0));
  const top10 = sum(people.slice(0, 10));
  const owners: Owner[] = people.slice(0, TOP_OWNERS).map((h, i) => ({ address: h.address, pct: pctOf(h), rank: i + 1 }));
  return {
    token: tok.token.address,
    chain: tok.chain.key,
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
  const pctBy = new Map(base.top_owners.map((o) => [o.address, o.pct]));
  const deployer = c.deployer.address;

  const bundles = new Set(c.launch.bundles.map((b) => b.buyer));
  const snipers = new Set(c.launch.snipers.map((b) => b.buyer));
  const contracts = new Set(c.holders.filter((h) => h.isContract).map((h) => h.address));

  const owners: Owner[] = base.top_owners.map((o) => {
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
    if (w?.sink) out.kind = 'sink';
    else if (contracts.has(o.address)) out.kind = 'contract';
    return out;
  });
  const drawn = new Set(owners.map((o) => o.address));

  const clusters = a.clusters.map((cl) => {
    const vias = a.links.filter((l) => l.via && cl.members.includes(l.a)).map((l) => l.via!);
    const funder = mostCommon(vias);
    const strong = cl.reasons.some((r) => STRONG.includes(r));
    return {
      pct: round(cl.share),
      wallets: cl.members.length,
      reason: cl.reasons.join(' · '),
      members: cl.members,
      funder,
      funder_is_holder: Boolean(funder && drawn.has(funder)),
      evidence: strong ? 'strong' : 'weak',
      weak_reason: strong ? null : 'timing and amounts only',
      owner: null,
      owner_label: null,
    };
  });

  // One line per pair on the map, of its strongest kind.
  const RANK: Record<string, number> = { transfer: 0, funder: 1, shared_funder: 2 };
  const byPair = new Map<string, { source: string; target: string; kind: string }>();
  for (const l of a.links
    .filter((l) => drawn.has(l.a) && drawn.has(l.b))
    .map((l) => {
      if (l.reason === 'direct transfer') return { source: l.a, target: l.b, kind: 'transfer' };
      if (l.reason === 'funded by deployer' && (l.a === deployer || l.b === deployer)) {
        // A holder funded by another holder: source is the funded wallet, target its funder.
        return { source: l.a === deployer ? l.b : l.a, target: deployer, kind: 'funder' };
      }
      return { source: l.a, target: l.b, kind: 'shared_funder' };
    })) {
    const key = [l.source, l.target].sort().join('|');
    const prev = byPair.get(key);
    if (!prev || RANK[l.kind]! < RANK[prev.kind]!) byPair.set(key, l);
  }
  const links = [...byPair.values()];

  const sumPct = (pred: (o: Owner) => boolean) => round(owners.filter(pred).reduce((s, o) => s + o.pct, 0), 1);
  const has = (r: string) => (o: Owner) => Boolean(o.roles?.includes(r));
  const launchPct = (buys: Buy[]) => round(buys.reduce((s, b) => s + shareOfRaw(b.raw), 0), 1);
  const measured = c.launch.measured;
  const clusteredPct = round(clusters.reduce((s, cl) => s + cl.pct, 0), 1);
  const largest = clusters.reduce((m, cl) => Math.max(m, cl.pct), 0);
  const insiderPct = sumPct((o) => has('insider')(o) || has('dev')(o));

  return {
    ...base,
    stage: 'full' as const,
    top_owners: owners,
    clusters,
    links,
    clustered_pct: clusteredPct,
    bubble_risk: clusteredPct >= 20 || largest >= 10 || insiderPct >= 10 ? 'High' : clusteredPct >= 8 ? 'Medium' : 'Low',
    funders_resolved: Object.values(a.wallets).filter((w) => w.trace === 'ok' && w.funder).length,
    reached_n: a.stats.traced,
    traces_failed: a.stats.failed,
    fresh_pct: sumPct(has('fresh')),
    fresh_n: owners.filter(has('fresh')).length,
    insider_pct: insiderPct,
    insider_n: owners.filter((o) => has('insider')(o) || has('dev')(o)).length,
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
