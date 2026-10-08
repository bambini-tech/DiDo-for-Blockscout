/**
 * Blockscout PRO API client.
 *
 * Two route families, one key for every chain:
 *   REST v2           https://api.blockscout.com/{chainId}/api/v2/{path}
 *   Etherscan-compat  https://api.blockscout.com/v2/api?chain_id=...&module=...
 *
 * Three things every caller relies on:
 *
 * 1. One rate gate for the whole process. Requests are spaced at 1/rps
 *    seconds no matter how many run concurrently, so a holder walk that fans
 *    out over hundreds of wallets never bursts past the key's limit.
 * 2. Retries on 429, 5xx and network errors (3 attempts, Retry-After honoured).
 * 3. Every answer says why it is empty. `absent` (Blockscout answered 404: it
 *    knows the chain and has never seen this address) and `error` (we could
 *    not look) are different answers, and a caller that merges them ends up
 *    telling a user "nothing here" when the truth is "we don't know".
 *
 * The API key travels as a query parameter, so URLs are never logged or put
 * into an error message as-is.
 */

export type Status = 'ok' | 'absent' | 'error';

export interface Result<T> {
  data: T | null;
  status: Status;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  rps?: number;
  timeoutMs?: number;
  attempts?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BlockscoutClient {
  readonly baseUrl: string;
  /** Requests sent upstream since start (retries included). */
  calls = 0;

  private readonly apiKey: string;
  private readonly interval: number;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private nextSlot = 0;

  constructor(opts: ClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.blockscout.com').replace(/\/+$/, '');
    this.interval = 1000 / (opts.rps ?? 4.5);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.attempts = opts.attempts ?? 3;
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
  }

  /** GET /{chainId}/api/v2/{path}. */
  async rest<T>(chainId: number, path: string, params: Record<string, string | number> = {}): Promise<Result<T>> {
    const url = new URL(`${this.baseUrl}/${chainId}/api/v2/${path.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await this.request(url, `REST ${chainId}/${path}`);
    if (!res) return { data: null, status: 'error' };
    if (res.status === 404) return { data: null, status: 'absent' };
    if (res.status !== 200) return { data: null, status: 'error' };
    try {
      return { data: (await res.json()) as T, status: 'ok' };
    } catch {
      return { data: null, status: 'error' };
    }
  }

  /**
   * GET /v2/api?chain_id=...&module=...&action=... (Etherscan envelope).
   * `status: "0"` with "No transactions found" is an answer -- an empty list --
   * not a failure.
   */
  async etherscan<T>(chainId: number, params: Record<string, string | number>): Promise<Result<T>> {
    const url = new URL(`${this.baseUrl}/v2/api`);
    url.searchParams.set('chain_id', String(chainId));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await this.request(url, `Etherscan ${chainId}/${params.action ?? '?'}`);
    if (!res || res.status !== 200) return { data: null, status: 'error' };
    let body: { status?: string; message?: string; result?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return { data: null, status: 'error' };
    }
    if (String(body.status) === '1') return { data: body.result as T, status: 'ok' };
    if (/no (transactions|records) found/i.test(String(body.message ?? ''))) {
      return { data: [] as unknown as T, status: 'ok' };
    }
    return { data: null, status: 'error' };
  }

  private async gate(): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.interval;
    if (slot > now) await this.sleep(slot - now);
  }

  private async request(url: URL, context: string): Promise<Response | null> {
    url.searchParams.set('apikey', this.apiKey);
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      await this.gate();
      this.calls++;
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        log(`${context}: network error (attempt ${attempt}/${this.attempts}): ${errName(err)}`);
        if (attempt < this.attempts) await this.sleep(500 * attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        log(`${context}: HTTP ${res.status} (attempt ${attempt}/${this.attempts})`);
        if (attempt < this.attempts) await this.sleep(retryAfterMs(res) ?? 500 * attempt);
        continue;
      }
      if (res.status !== 200 && res.status !== 404) log(`${context}: HTTP ${res.status}`);
      return res;
    }
    log(`${context}: giving up after ${this.attempts} attempts`);
    return null;
  }
}

function retryAfterMs(res: Response): number | null {
  const v = Number(res.headers.get('retry-after'));
  return Number.isFinite(v) && v >= 0 ? Math.min(v, 30) * 1000 : null;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

function log(msg: string): void {
  if (process.env.NODE_ENV !== 'test') console.warn(`[blockscout] ${msg}`);
}
