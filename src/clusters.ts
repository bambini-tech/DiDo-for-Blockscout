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
 *   identical amounts   one sender funded them with the exact same wei amount,
 *                       and not a round one (0.01 ETH from an exchange is what
 *                       thousands of strangers withdraw; 0.0137264 ETH is not)
 *   funded together     one sender funded them within a few minutes
 *
 * The last three hold even when the sender IS infrastructure (an exchange, a
 * bridge): "both came through Coinbase" says nothing, "Coinbase paid both in
 * one block" is a batch someone sent.
 *
 * Every rule runs twice: on native coin, and on the mapped token itself. A
 * treasury that hands supply to five multisigs within minutes never sends
 * them ETH, but it sends them the token, and that is the same operator. Token
 * links leave out exchange wallets (Blockscout tags them) and holders paid the
 * token by many senders: a user who withdrew from Binance is not Binance.
 *
 * Who never links:
 *   - named contracts (pools, routers, lockers): they hold supply, but nobody
 *     "funds" a pool the way an operator funds a wallet. A contract that IS a
 *     wallet (a Safe, a multisig) links like one;
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
  /** A wallet with fewer plain transactions than this, ever, is fresh. */
  freshMaxTxs: number;
}

export const DEFAULT_LINK_OPTIONS: LinkOptions = {
  infraMinTxs: 2_000,
  sinkMinSenders: 15,
  sameBlockMin: 2,
  sameAmountMin: 3,
  togetherWindowSec: 300,
  togetherMin: 3,
  freshMaxTxs: 10,
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
  /** Blockscout tags it as an exchange wallet. */
  exchange?: boolean;
  /** A contract that is a wallet (Safe, multisig, smart account). */
  wallet?: boolean;
  /** Its token balance (raw units): token movements far smaller than it are noise, not funding. */
  raw?: string;
}

export interface LinkInput {
  holders: HolderIn[];
  creator: string | null;
  traces: Map<string, FundingTrace>;
  /** Lifetime tx counts of shared senders; null = could not be read. */
  txCounts: Map<string, number | null>;
  /** The mapped token's decimals: what makes a token amount "round". */
  tokenDecimals?: number;
  /**
   * Senders Blockscout says are contracts (not Safes or multisigs). A
   * contract that pays out the token (staking rewards, vesting, a
   * distributor) owns none of the holders it pays: it never links on the
   * token. On native coin it counts as infrastructure: no shared funder, but
   * one block, identical amounts or minutes apart still do (a disperse batch).
   */
  contractSenders?: Set<string>;
  /**
   * Senders whose identity could be read. When given, a token sender outside
   * it links nobody: we only claim a token-funded cluster we could check is
   * not a payout contract.
   */
  checkedSenders?: Set<string>;
  options?: Partial<LinkOptions>;
}

export interface Link {
  a: string;
  b: string;
  reason: Reason;
  /** The sender behind a funding link. */
  via?: string;
  /** The transaction that is the evidence (for a group link: the one that paid `b`). */
  tx?: string;
  /** For a group link, the transaction that paid `a` from the same sender. */
  txA?: string;
  /** The link is on the mapped token, not native coin. */
  asset?: 'token';
}

export interface Cluster {
  id: number;
  members: string[];
  share: number;
  reasons: Reason[];
  /** Some of its links are on the mapped token itself. */
  tokenLinked: boolean;
}

export interface WalletInfo {
  funder: string | null;
  fundingKind: FundingTrace['kind'];
  /** First activity and first funding inflow (unix seconds), for the funding replay. */
  firstTs: number | null;
  fundTs: number | null;
  /** The transaction that funded it: what "funded by" opens on Blockscout. */
  fundTx: string | null;
  /** Fewer than `freshMaxTxs` plain transactions in the wallet's whole history. */
  fresh: boolean;
  trace: 'ok' | 'error' | 'skipped';
  /** Why a trace failed, in Blockscout's words. */
  traceError?: string;
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
    if (!t) continue;
    const flows = [...(t.status === 'ok' ? inflows(t) : []), ...(h.exchange ? [] : tokenInflows(t))];
    for (const s of new Set(flows.map((f) => f.peer))) {
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
  const tokenUnit = 10n ** BigInt(Math.max(0, (input.tokenDecimals ?? 18) - 4));

  const wallets: Record<string, WalletInfo> = {};
  const linkable: string[] = [];
  const tokenLinkable: string[] = [];
  // Token movements that count: at least 1% of what the holder holds now.
  // Spam drops ("visit … to claim your rewards") and 1-token test sends land
  // on every big holder; they say nothing about who owns it.
  const tokenFlowsOf = new Map<string, Flow[]>();
  for (const h of input.holders) {
    const t = input.traces.get(h.address);
    if (!t?.tokenFlows) continue;
    const floor = BigInt(h.raw ?? '0') / 100n;
    tokenFlowsOf.set(h.address, t.tokenFlows.filter((f) => BigInt(f.value) >= floor));
  }
  for (const h of input.holders) {
    const t = input.traces.get(h.address);
    const native = t && t.status === 'ok' ? inflows(t) : [];
    const token = (tokenFlowsOf.get(h.address) ?? []).filter((f) => f.dir === 'in');
    const sink = new Set(native.map((f) => f.peer)).size >= opt.sinkMinSenders;
    const tokenSink = new Set(token.map((f) => f.peer)).size >= opt.sinkMinSenders;
    // Who funded it: native coin first (where the wallet came from); a wallet
    // never paid native coin (a multisig) was funded by whoever sent it the token.
    const nativeFunding = t ? native.find((f) => f.peer === t.funder) : undefined;
    const byToken = (!t?.funder || t.kind === 'first-tx') && token.length > 0 ? token[0]! : undefined;
    wallets[h.address] = {
      funder: byToken?.peer ?? t?.funder ?? null,
      fundingKind: byToken ? 'token' : t?.kind ?? null,
      firstTs: t?.firstTs ?? byToken?.ts ?? null,
      fundTs: byToken?.ts ?? nativeFunding?.ts ?? null,
      fundTx: byToken?.hash ?? nativeFunding?.hash ?? null,
      // A contract (a multisig) sends few transactions by design: "fresh" is a wallet's word.
      fresh: Boolean(!h.isContract && t && t.status === 'ok' && !t.windowFull && t.txCount < opt.freshMaxTxs),
      trace: !t ? 'skipped' : t.status === 'ok' || t.tokenFlows ? 'ok' : 'error',
      ...(t?.error ? { traceError: t.error } : {}),
      cluster: null,
      deployer: h.address === creator,
      deployerFunded: Boolean(creator && h.address !== creator && [...native, ...token].some((f) => f.peer === creator)),
      sink,
    };
    const namedContract = h.isContract && Boolean(h.name) && !h.wallet;
    if (namedContract) continue;
    if (t?.status === 'ok' && !sink) linkable.push(h.address);
    if (t?.tokenFlows && !tokenSink && !h.exchange) tokenLinkable.push(h.address);
  }
  const canLink = new Set(linkable);
  const canLinkToken = new Set(tokenLinkable);

  const uf = new UnionFind();
  const links: Link[] = [];
  const reasonsOf = new Map<string, Set<Reason>>();
  const tokenLinked = new Set<string>();
  const seenPair = new Set<string>();
  const join = (a: string, b: string, reason: Reason, extra: { via?: string; tx?: string | null; txA?: string | null; token?: boolean } = {}) => {
    if (a === b) return;
    const key = `${a < b ? a : b}|${a < b ? b : a}|${reason}|${extra.token ? 't' : 'n'}`;
    if (seenPair.has(key)) return;
    seenPair.add(key);
    uf.union(a, b);
    links.push({ a, b, reason, ...(extra.via ? { via: extra.via } : {}), ...(extra.tx ? { tx: extra.tx } : {}), ...(extra.txA ? { txA: extra.txA } : {}), ...(extra.token ? { asset: 'token' as const } : {}) });
    for (const x of [a, b]) {
      if (!reasonsOf.has(x)) reasonsOf.set(x, new Set());
      reasonsOf.get(x)!.add(reason);
      if (extra.token) tokenLinked.add(x);
    }
  };
  /** Star-link a group to its largest holder, so the map draws k-1 lines, not k². */
  const joinGroup = (group: string[], reason: Reason, via: string, per: Map<string, Flow[]>, token: boolean) => {
    const sorted = [...group].sort((x, y) => (shareOf.get(y) ?? 0) - (shareOf.get(x) ?? 0) || cmp(x, y));
    const txA = per.get(sorted[0]!)?.[0]?.hash ?? null;
    for (const m of sorted.slice(1)) join(sorted[0]!, m, reason, { via, tx: per.get(m)?.[0]?.hash ?? null, txA, token });
  };

  const senders: Sender[] = [];
  const passes: Array<{ token: boolean; members: string[]; can: Set<string>; flowsOf: (t: FundingTrace) => Flow[]; unit: bigint }> = [
    { token: false, members: linkable, can: canLink, flowsOf: (t) => t.flows, unit: 100_000_000_000_000n },
    { token: true, members: tokenLinkable, can: canLinkToken, flowsOf: (t) => tokenFlowsOf.get(t.wallet) ?? [], unit: tokenUnit },
  ];
  for (const pass of passes) {
    // Direct transfers between two members, either direction.
    for (const a of pass.members) {
      for (const f of pass.flowsOf(input.traces.get(a)!)) {
        if (pass.can.has(f.peer)) join(a, f.peer, 'direct transfer', { tx: f.hash, token: pass.token });
      }
    }

    // Inflows from outside senders: sender -> member -> events.
    const bySender = new Map<string, Map<string, Flow[]>>();
    for (const m of pass.members) {
      for (const f of pass.flowsOf(input.traces.get(m)!).filter((x) => x.dir === 'in')) {
        if (isHolder(f.peer) && f.peer !== creator) continue; // holder->holder is a direct transfer
        if (!bySender.has(f.peer)) bySender.set(f.peer, new Map());
        const per = bySender.get(f.peer)!;
        if (!per.has(m)) per.set(m, []);
        per.get(m)!.push(f);
      }
    }

    for (const [sender, per] of [...bySender].sort(([x], [y]) => cmp(x, y))) {
      const members = [...per.keys()];
      if (sender === creator) {
        // The deployer is never "infrastructure" for its own token.
        if (pass.can.has(creator)) for (const m of members) join(creator, m, 'funded by deployer', { via: creator, tx: per.get(m)?.[0]?.hash ?? null, token: pass.token });
        else if (members.length >= 2) joinGroup(members, 'funded by deployer', creator, per, pass.token);
        continue;
      }
      if (members.length < 2) continue;
      const contract = input.contractSenders?.has(sender) ?? false;
      if (pass.token && (contract || (input.checkedSenders && !input.checkedSenders.has(sender)))) continue;
      const txCount = input.txCounts.has(sender) ? input.txCounts.get(sender)! : null;
      // Unknown counts as infrastructure: we only claim a shared-funder cluster we could check.
      const infrastructure = contract ? true : txCount === null ? null : txCount >= opt.infraMinTxs;
      if (!senders.some((x) => x.address === sender)) senders.push({ address: sender, funded: members.length, txCount, infrastructure });
      if (infrastructure === false) joinGroup(members, 'shared funder', sender, per, pass.token);
      for (const [reason, group] of fingerprints(per, opt, pass.unit)) joinGroup(group, reason, sender, per, pass.token);
    }
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
        tokenLinked: members.some((m) => tokenLinked.has(m)),
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

function tokenInflows(t: FundingTrace): Flow[] {
  return (t.tokenFlows ?? []).filter((f) => f.dir === 'in');
}

/** Same block, identical amount, funded within the window -- per sender. */
function fingerprints(per: Map<string, Flow[]>, opt: LinkOptions, unit: bigint): Array<[Reason, string[]]> {
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
  bucket((f) => (isRound(f.value, unit) ? null : f.value), 'identical amounts', opt.sameAmountMin);

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

/** Whole multiples of 0.0001 of the coin (10^14 wei for an 18-decimal one) are round. */
export function isRound(wei: string, unit = 100_000_000_000_000n): boolean {
  try {
    return BigInt(wei) % unit === 0n;
  } catch {
    return false;
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
