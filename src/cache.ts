/** A small in-memory TTL cache with a size bound. */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max = 500,
    private readonly now: () => number = Date.now,
  ) {}

  clear(): void {
    this.map.clear();
  }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  /** `ttlMs` overrides the cache's own lifetime for this entry. */
  set(key: string, value: V, ttlMs = this.ttlMs): void {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: this.now() + ttlMs });
  }
}
