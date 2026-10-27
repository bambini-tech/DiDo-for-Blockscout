/**
 * Keeps the entry board: one read shortly after start, then one every
 * `intervalMs` (4 h). The last good read is served until the next one lands;
 * a read that throws keeps the old board and is retried at the next beat.
 *
 * A round takes 20-30 minutes, so nothing waits for it: until the first
 * complete read, the round's partial reads are served (trending a few
 * minutes in, then the garden as tokens are read). With `snapshotPath` (a
 * mounted volume on Railway), the last complete board is written to disk and
 * served again after a restart or a deploy while the next round runs.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readBoard, type BoardDoc, type ReadDeps } from './read.js';

/** A saved board older than this is not served after a restart. */
const SNAPSHOT_MAX_AGE_S = 8 * 3600;

export class BoardKeeper {
  doc: BoardDoc | null = null;
  reading = false;
  lastError: string | null = null;
  startedAt: number | null = null;
  readAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: ReadDeps,
    private readonly log: (msg: string) => void = () => {},
    private readonly snapshotPath: string | null = null,
  ) {
    if (!snapshotPath) return;
    try {
      const saved = JSON.parse(readFileSync(snapshotPath, 'utf8')) as BoardDoc;
      const age = Date.now() / 1000 - saved.read_at;
      if (saved && !saved.partial && Array.isArray(saved.let_go) && age < SNAPSHOT_MAX_AGE_S) {
        this.doc = saved;
        this.readAt = saved.read_at * 1000;
        this.log(`board: serving the saved read from ${Math.round(age / 60)} min ago while the next round runs`);
      }
    } catch {
      /* no snapshot yet: the first round fills the board */
    }
  }

  start(firstDelayMs = 5_000): void {
    const beat = async () => {
      await this.readNow();
      this.timer = setTimeout(beat, this.deps.intervalMs);
      this.timer.unref?.();
    };
    this.timer = setTimeout(beat, firstDelayMs);
    this.timer.unref?.();
  }

  /** For /health: whether a board is up, when it was read, and whether a round is running. */
  status() {
    const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
    return { ready: Boolean(this.doc), partial: Boolean(this.doc?.partial), reading: this.reading, round_started: iso(this.startedAt), read_at: iso(this.readAt), last_error: this.lastError };
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async readNow(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    const t0 = Date.now();
    this.startedAt = t0;
    try {
      this.doc = await readBoard({
        ...this.deps,
        // A partial read never replaces a complete board, only an empty or partial one.
        onPartial: (d) => { if (!this.doc || this.doc.partial) this.doc = d; },
      });
      this.lastError = null;
      this.readAt = Date.now();
      if (this.snapshotPath) {
        try {
          mkdirSync(dirname(this.snapshotPath), { recursive: true });
          writeFileSync(this.snapshotPath, JSON.stringify(this.doc));
        } catch (e) {
          this.log(`board: could not save the snapshot: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
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
