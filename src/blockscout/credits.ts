/**
 * What the Blockscout PRO API charges, and a brake against a runaway day.
 *
 * Blockscout prices each route in credits (most cost 20; the price list is
 * public at api.blockscout.com/api/json/config and is read at start, with a
 * built-in copy of the routes DiDo uses as the fallback). The plan sets the
 * budget:
 *
 *   builder  15 req/s, 100M credits a month, overage billed (not refused)
 *   free      5 req/s, 100k credits a day
 *
 * The ledger charges each logical request once (a retry of the same request
 * is not billed again here), keeps today's and this month's totals in memory,
 * and refuses new requests for the rest of the UTC day once the day's brake is
 * reached -- on builder twice an even day's share of the month, far above any
 * real day, so a stuck loop cannot spend a week's credits. A refused request
 * reads as an error to every caller, never as "nothing here".
 */
export interface Plan {
  name: 'builder' | 'free';
  rps: number;
  monthlyCredits: number;
  dailyBrake: number;
  /** Holders traced per token, and requests in flight at once. */
  traceLimit: number;
  concurrency: number;
}

export const PLANS: Record<Plan['name'], Plan> = {
  // 90% of the plan's request rate: headroom for jitter, one process, one key.
  // In flight: the live API answers in ~2 s, so ~30 at once keep a 13.5/s gate full.
  builder: { name: 'builder', rps: 13.5, monthlyCredits: 100_000_000, dailyBrake: Math.floor((100_000_000 / 31) * 2), traceLimit: 100, concurrency: 32 },
  free: { name: 'free', rps: 4.5, monthlyCredits: 0, dailyBrake: 90_000, traceLimit: 50, concurrency: 6 },
};

/** The routes DiDo calls, as Blockscout prices them (all standard: 20). */
/** Stands in when the published list cannot be read: the default, and the one priced route DiDo uses. */
const BUILT_IN: Record<string, number> = { default: 20, 'multichain/api/v1/clusters/{cluster_id}/search/addresses': 120 };

export class CreditLedger {
  private prices: Record<string, number> = { ...BUILT_IN };
  private day = '';
  private month = '';
  today = 0;
  thisMonth = 0;
  refused = 0;
  /** Today's requests and credits per route -- where the credits go. */
  private byRoute = new Map<string, { requests: number; credits: number; ms_total?: number; ms_max?: number }>();

  constructor(readonly plan: Plan, private readonly now: () => number = Date.now) {}

  /** Read Blockscout's published price list (no key needed). Keeps the built-in copy on failure. */
  async loadPricing(fetchFn: typeof fetch = fetch, url = 'https://api.blockscout.com/api/json/config'): Promise<boolean> {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
      const doc = (await res.json()) as { endpoint_pricing?: Record<string, number> };
      if (!doc.endpoint_pricing || typeof doc.endpoint_pricing.default !== 'number') return false;
      this.prices = { ...BUILT_IN, ...doc.endpoint_pricing };
      return true;
    } catch {
      return false;
    }
  }

  /** Credits for one request to this URL path. */
  priceOf(pathname: string): number {
    // /{chainId}/api/v2/addresses/0xabc.../counters -> api/v2/addresses/:address_hash/counters
    const route = pathname
      .replace(/^\/\d+\//, '')
      .replace(/^\//, '')
      .replace(/0x[0-9a-fA-F]{64}/g, ':hash')
      .replace(/0x[0-9a-fA-F]{40}/g, ':address_hash')
      // The aggregator's cluster routes are priced per template: clusters/{cluster_id}/...
      .replace(/^(multichain\/api\/v1\/clusters)\/[^/]+\//, '$1/{cluster_id}/');
    return this.prices[route] ?? this.prices.default ?? 20;
  }

  /** Record how long a request took (from first send to final answer, retries included). */
  observe(label: string, ms: number): void {
    const r = this.byRoute.get(routeOf(label));
    if (!r) return;
    r.ms_total = (r.ms_total ?? 0) + ms;
    r.ms_max = Math.max(r.ms_max ?? 0, ms);
  }

  /** Charge a request; false when today's brake is reached (the request is not sent). */
  charge(pathname: string, label?: string): boolean {
    this.roll();
    const price = this.priceOf(pathname);
    if (this.plan.dailyBrake > 0 && this.today + price > this.plan.dailyBrake) {
      this.refused++;
      return false;
    }
    this.today += price;
    this.thisMonth += price;
    const key = routeOf(label ?? pathname);
    const r = this.byRoute.get(key) ?? { requests: 0, credits: 0 };
    r.requests++;
    r.credits += price;
    this.byRoute.set(key, r);
    return true;
  }

  stats() {
    this.roll();
    return {
      plan: this.plan.name,
      rps: this.plan.rps,
      credits_today: this.today,
      credits_month: this.thisMonth,
      daily_brake: this.plan.dailyBrake,
      monthly_allowance: this.plan.monthlyCredits || null,
      refused_today: this.refused,
      // Per route: requests, credits, and how long Blockscout took to answer
      // (retries included): the first place to look when a map is slow.
      routes_today: Object.fromEntries([...this.byRoute].sort((a, b) => b[1].credits - a[1].credits).map(([k, v]) => [k, {
        requests: v.requests, credits: v.credits,
        ...(v.ms_total !== undefined ? { avg_ms: Math.round(v.ms_total / Math.max(1, v.requests)), max_ms: v.ms_max } : {}),
      }])),
      since: 'process start (in-memory tallies)',
    };
  }

  private roll(): void {
    const iso = new Date(this.now()).toISOString();
    const day = iso.slice(0, 10);
    const month = iso.slice(0, 7);
    if (day !== this.day) {
      this.day = day;
      this.today = 0;
      this.refused = 0;
      this.byRoute.clear();
    }
    if (month !== this.month) {
      this.month = month;
      this.thisMonth = 0;
    }
  }
}

/** A request's route with its addresses and hashes taken out (and the chain prefix kept as "{chain}"). */
function routeOf(path: string): string {
  return path
    .replace(/^\/\d+\//, '/{chain}/')
    .replace(/0x[0-9a-fA-F]{64}/g, ':hash')
    .replace(/0x[0-9a-fA-F]{40}/g, ':address');
}

export function planNamed(name: string | undefined): Plan {
  return name?.trim().toLowerCase() === 'free' ? PLANS.free : PLANS.builder;
}
