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
  builder: { name: 'builder', rps: 13.5, monthlyCredits: 100_000_000, dailyBrake: Math.floor((100_000_000 / 31) * 2), traceLimit: 100, concurrency: 12 },
  free: { name: 'free', rps: 4.5, monthlyCredits: 0, dailyBrake: 90_000, traceLimit: 50, concurrency: 6 },
};

/** The routes DiDo calls, as Blockscout prices them (all standard: 20). */
const BUILT_IN: Record<string, number> = { default: 20 };

export class CreditLedger {
  private prices: Record<string, number> = { ...BUILT_IN };
  private day = '';
  private month = '';
  today = 0;
  thisMonth = 0;
  refused = 0;

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
      .replace(/0x[0-9a-fA-F]{40}/g, ':address_hash');
    return this.prices[route] ?? this.prices.default ?? 20;
  }

  /** Charge a request; false when today's brake is reached (the request is not sent). */
  charge(pathname: string): boolean {
    this.roll();
    const price = this.priceOf(pathname);
    if (this.plan.dailyBrake > 0 && this.today + price > this.plan.dailyBrake) {
      this.refused++;
      return false;
    }
    this.today += price;
    this.thisMonth += price;
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
    }
    if (month !== this.month) {
      this.month = month;
      this.thisMonth = 0;
    }
  }
}

export function planNamed(name: string | undefined): Plan {
  return name?.trim().toLowerCase() === 'free' ? PLANS.free : PLANS.builder;
}
