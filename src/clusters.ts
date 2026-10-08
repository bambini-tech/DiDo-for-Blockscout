/**
 * Linking holders into clusters. Pure: everything it needs from Blockscout is
 * passed in, so every rule here is testable offline.
 *
 * Links, strongest first. A cluster lists every kind of link that holds it
 * together, in this order.
 *
 *   direct transfer     one holder sent native coin straight to another
 *   funded by deployer  the token's deployer sent the holder native coin
 *   shared funder       two holders took native coin from the same sender,
 *                       and that sender is not infrastructure
 *   same block          one sender funded them in the same block
 *   identical amounts   one sender funded them with the exact same wei amount
 *   funded together     one sender funded them within a few minutes
 *
 * The last three hold even when the sender IS infrastructure (an exchange, a
 * bridge): "both came through Coinbase" says nothing, "Coinbase paid both in
 * one block" is a batch someone sent.
 *
 * Who never links on native coin:
 *   - named contracts (pools, routers, lockers): they hold supply, but nobody
 *     "funds" a pool the way an operator funds a wallet;
 *   - sinks: a holder paid by many different senders is a deposit address or a
 *     treasury, and would wire every one of them together.
 *
 * Weak funders (`first-tx`) are shown, never linked on.
 */
import type { Flow, FundingTrace } from './blockscout/addresses.js';

export interface LinkOptions {
  /** A sender with at least this many lifetime transactions is infrastructure. */
  infraMinTxs: number;
  /** A holder paid by at least this many distinct senders is a sink. */
  sinkMinSenders: number;
  /** Members a same-block group needs. */
  sameBlockMin: number;
  /** Members an identical-amount group needs. */
  sameAmountMin: number;
  /** "Funded together": window, and the members a group needs. */
  togetherWindowSec: number;
  togetherMin: number;
}

export const DEFAULT_LINK_OPTIONS: LinkOptions = {
  infraMinTxs: 2_000,
  sinkMinSenders: 8,
  sameBlockMin: 2,
  sameAmountMin: 3,
  togetherWindowSec: 300,
  togetherMin: 3,
};

export const REASONS = [
  'direct transfer',
  'funded by deployer',
  'shared funder',
  'same block',
  'identical amounts',
  'funded together',
] as const;
export type Reason = (typeof REASONS)[number];

export interface HolderIn {
  address: string;
  share: number | null;
  isContract: boolean;
  name: string | null;
}

export interface LinkInput {
  holders: HolderIn[];
  creator: string | null;
  traces: Map<string, FundingTrace>;
  /** Lifetime tx counts of shared senders; null = could not be read. */
  txCounts: Map<string, number | null>;
  options?: Partial<LinkOptions>;
}

export interface Link {
  a: string;
  b: string;
  reason: Reason;
  /** The sender behind a funding link. */
  via?: string;
}

export interface Cluster {
  id: number;
  members: string[];
  share: number;
  reasons: Reason[];
}

export interface WalletInfo {
  funder: string | null;
  fundingKind: FundingTrace['kind'];
  trace: 'ok' | 'error' | 'skipped';
  cluster: number | null;
  deployer: boolean;
  deployerFunded: boolean;
  sink: boolean;
}

export interface Sender {
  address: string;
  funded: number;
  txCount: number | null;
  infrastructure: boolean | null;
}

export interface LinkResult {
  clusters: Cluster[];
  links: Link[];
  wallets: Record<string, WalletInfo>;
  senders: Sender[];
  stats: {
    traced: number;
    failed: number;
    clusteredShare: number;
    deployerLinkedShare: number;
  };
}

/** Senders that funded two or more members: the ones that need a tx count. */
export function sharedSenders(holders: HolderIn[], traces: Map<string, FundingTrace>): string[] {
  const members = new Set(holders.map((h) => h.address));
  const count = new Map<string, number>();
  for (const h of holders) {
    const t = traces.get(h.address);
    if (!t || t.status !== 'ok') continue;
    for (const s of new Set(inflows(t).map((f) => f.peer))) {
      if (!members.has(s)) count.set(s, (count.get(s) ?? 0) + 1);
    }
  }
  return [...count].filter(([, n]) => n >= 2).map(([s]) => s).sort();
}

export function linkHolders(input: LinkInput): LinkResult {
  const opt = { ...DEFAULT_LINK_OPTIONS, ...input.options };
  const creator = input.creator?.toLowerCase() ?? null;
  const shareOf = new Map(input.holders.map((h) => [h.address, h.share ?? 0]));
  const isHolder = (a: string) => shareOf.has(a);

  const wallets: Record<string, WalletInfo> = {};
  const linkable: string[] = [];
  for (const h of input.holders) {
    const t = input.traces.get(h.address);
    const senders = new Set(t ? inflows(t).map((f) => f.peer) : []);
    const sink = senders.size >= opt.sinkMinSenders;
    wallets[h.address] = {
      funder: t?.funder ?? null,
      fundingKind: t?.kind ?? null,
      trace: !t ? 'skipped' : t.status === 'ok' ? 'ok' : 'error',
      cluster: null,
      deployer: h.address === creator,
      deployerFunded: Boolean(creator && senders.has(creator)),
      sink,
    };
    const namedContract = h.isContract && Boolean(h.name);
    if (t?.status === 'ok' && !sink && !namedContract) linkable.push(h.address);
  }
  const canLink = new Set(linkable);

  const uf = new UnionFind();
  const links: Link[] = [];
  const reasonsOf = new Map<string, Set<Reason>>();
  const seenPair = new Set<string>();
  const join = (a: string, b: string, reason: Reason, via?: string) => {
    if (a === b) return;
    const key = `${a < b ? a : b}|${a < b ? b : a}|${reason}`;
    if (seenPair.has(key)) return;
    seenPair.add(key);
    uf.union(a, b);
    links.push(via ? { a, b, reason, via } : { a, b, reason });
    for (const x of [a, b]) {
      if (!reasonsOf.has(x)) reasonsOf.set(x, new Set());
      reasonsOf.get(x)!.add(reason);
    }
  };
  /** Star-link a group to its largest holder, so the map draws k-1 lines, not k². */
  const joinGroup = (group: string[], reason: Reason, via?: string) => {
    const sorted = [...group].sort((x, y) => (shareOf.get(y) ?? 0) - (shareOf.get(x) ?? 0) || cmp(x, y));
    for (const m of sorted.slice(1)) join(sorted[0]!, m, reason, via);
  };

  // Direct native transfers between two members, either direction.
  for (const a of linkable) {
    for (const f of input.traces.get(a)!.flows) {
      if (canLink.has(f.peer)) join(a, f.peer, 'direct transfer');
    }
  }

  // Inflows from outside senders: sender -> member -> events.
  const bySender = new Map<string, Map<string, Flow[]>>();
  for (const m of linkable) {
    for (const f of inflows(input.traces.get(m)!)) {
      if (isHolder(f.peer) && f.peer !== creator) continue; // holder->holder is a direct transfer
      if (!bySender.has(f.peer)) bySender.set(f.peer, new Map());
      const per = bySender.get(f.peer)!;
      if (!per.has(m)) per.set(m, []);
      per.get(m)!.push(f);
    }
  }

  const senders: Sender[] = [];
  for (const [sender, per] of [...bySender].sort(([x], [y]) => cmp(x, y))) {
    const members = [...per.keys()];
    if (sender === creator) {
      // The deployer is never "infrastructure" for its own token.
      if (canLink.has(creator)) for (const m of members) join(creator, m, 'funded by deployer', creator);
      else if (members.length >= 2) joinGroup(members, 'funded by deployer', creator);
      continue;
    }
    if (members.length < 2) continue;
    const txCount = input.txCounts.has(sender) ? input.txCounts.get(sender)! : null;
    // Unknown counts as infrastructure: we only claim a shared-funder cluster we could check.
    const infrastructure = txCount === null ? null : txCount >= opt.infraMinTxs;
    senders.push({ address: sender, funded: members.length, txCount, infrastructure });
    if (infrastructure === false) joinGroup(members, 'shared funder', sender);
    for (const [reason, group] of fingerprints(per, opt)) joinGroup(group, reason, sender);
  }

  // Clusters: connected components of two or more.
  const comps = new Map<string, string[]>();
  for (const a of uf.items()) {
    const r = uf.find(a);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r)!.push(a);
  }
  const clusters: Cluster[] = [...comps.values()]
    .filter((m) => m.length >= 2)
    .map((members) => {
      const reasons = new Set<Reason>();
      for (const m of members) for (const r of reasonsOf.get(m) ?? []) reasons.add(r);
      return {
        id: 0,
        members: members.sort((x, y) => (shareOf.get(y) ?? 0) - (shareOf.get(x) ?? 0) || cmp(x, y)),
        share: round4(members.reduce((s, m) => s + (shareOf.get(m) ?? 0), 0)),
        reasons: REASONS.filter((r) => reasons.has(r)),
      };
    })
    .sort((x, y) => y.share - x.share || y.members.length - x.members.length || cmp(x.members[0]!, y.members[0]!));
  clusters.forEach((c, i) => {
    c.id = i + 1;
    for (const m of c.members) if (wallets[m]) wallets[m].cluster = c.id;
  });

  const shareWhere = (pred: (w: WalletInfo) => boolean) =>
    round4(input.holders.filter((h) => pred(wallets[h.address]!)).reduce((s, h) => s + (h.share ?? 0), 0));
  const traced = Object.values(wallets).filter((w) => w.trace !== 'skipped');

  return {
    clusters,
    links,
    wallets,
    senders,
    stats: {
      traced: traced.length,
      failed: traced.filter((w) => w.trace === 'error').length,
      clusteredShare: shareWhere((w) => w.cluster !== null),
      deployerLinkedShare: shareWhere((w) => w.deployer || w.deployerFunded),
    },
  };
}

function inflows(t: FundingTrace): Flow[] {
  return t.flows.filter((f) => f.dir === 'in');
}

/** Same block, identical amount, funded within the window -- per sender. */
function fingerprints(per: Map<string, Flow[]>, opt: LinkOptions): Array<[Reason, string[]]> {
  const out: Array<[Reason, string[]]> = [];
  const bucket = (key: (f: Flow) => string | null, reason: Reason, min: number) => {
    const groups = new Map<string, Set<string>>();
    for (const [m, flows] of per) {
      for (const f of flows) {
        const k = key(f);
        if (k === null) continue;
        if (!groups.has(k)) groups.set(k, new Set());
        groups.get(k)!.add(m);
      }
    }
    for (const g of groups.values()) if (g.size >= Math.max(2, min)) out.push([reason, [...g].sort()]);
  };
  bucket((f) => (f.block === null ? null : String(f.block)), 'same block', opt.sameBlockMin);
  bucket((f) => f.value, 'identical amounts', opt.sameAmountMin);

  // Time windows are anchored on their first event and never chained, so a
  // sender paying strangers all day gives many small groups, not one big one.
  if (opt.togetherWindowSec > 0) {
    const timed = [...per]
      .flatMap(([m, flows]) => flows.filter((f) => f.ts !== null).map((f) => [f.ts!, m] as const))
      .sort((x, y) => x[0] - y[0] || cmp(x[1], y[1]));
    let i = 0;
    while (i < timed.length) {
      const anchor = timed[i]![0];
      const group = new Set<string>();
      let j = i;
      while (j < timed.length && timed[j]![0] - anchor <= opt.togetherWindowSec) group.add(timed[j++]![1]);
      if (group.size >= Math.max(2, opt.togetherMin)) out.push(['funded together', [...group].sort()]);
      i = j;
    }
  }
  return out;
}

class UnionFind {
  private parent = new Map<string, string>();
  items(): string[] {
    return [...this.parent.keys()];
  }
  find(a: string): string {
    if (!this.parent.has(a)) this.parent.set(a, a);
    let r = a;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let x = a;
    while (this.parent.get(x) !== r) {
      const next = this.parent.get(x)!;
      this.parent.set(x, r);
      x = next;
    }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
