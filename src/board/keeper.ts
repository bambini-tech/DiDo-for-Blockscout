/**
 * Keeps the entry board: one read shortly after start, then one every
 * `intervalMs` (4 h). The last good read is served until the next one lands;
 * a read that throws keeps the old board and is retried at the next beat.
 */
import { readBoard, type BoardDoc, type ReadDeps } from './read.js';

export class BoardKeeper {
  doc: BoardDoc | null = null;
  reading = false;
  lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ReadDeps, private readonly log: (msg: string) => void = () => {}) {}

  start(firstDelayMs = 5_000): void {
    const beat = async () => {
      await this.readNow();
      this.timer = setTimeout(beat, this.deps.intervalMs);
      this.timer.unref?.();
    };
    this.timer = setTimeout(beat, firstDelayMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async readNow(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    const t0 = Date.now();
    try {
      this.doc = await readBoard(this.deps);
      this.lastError = null;
      const c = this.doc.counts;
      this.log(`board read in ${Math.round((Date.now() - t0) / 1000)}s: ${c.read} read, ${c.solid} solid, ${c.board} at entry, ${c.near} near, ${c.support} support, ${c.hot} hot`);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.log(`board read failed: ${this.lastError}`);
    } finally {
      this.reading = false;
    }
  }
}
