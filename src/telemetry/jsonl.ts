import { randomUUID } from 'node:crypto';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Observation, ObservationTransport } from './adapter.js';

export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_MAX_PENDING = 256;

/** One private, size-bounded file per run; no retries or synchronous disk IO. */
export class JsonlTransport implements ObservationTransport {
  readonly filename: string;
  private pending: string[] = [];
  private acceptedBytes = 0;
  private active: Promise<void> | undefined;
  private file: FileHandle | undefined;
  private failed = false;
  private closing = false;
  private shutdown: Promise<void> | undefined;
  private readonly maxBytes: number;
  private readonly maxPending: number;
  private readonly directory: string;

  constructor(directory: string, options: { maxBytes?: number; maxPending?: number } = {}) {
    this.directory = directory;
    this.filename = join(directory, `switchboard-${randomUUID()}.jsonl`);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > DEFAULT_MAX_BYTES ||
        !Number.isSafeInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > DEFAULT_MAX_PENDING) {
      throw new Error('Invalid telemetry bounds');
    }
  }

  offer(observation: Observation): void {
    if (this.failed || this.closing || this.pending.length >= this.maxPending) return;
    const line = JSON.stringify(observation) + '\n';
    const bytes = Buffer.byteLength(line);
    if (this.acceptedBytes + bytes > this.maxBytes) return;
    this.acceptedBytes += bytes;
    this.pending.push(line);
    this.schedule();
  }

  private schedule(): void {
    if (this.active) return;
    this.active = Promise.resolve().then(() => this.drain()).finally(() => {
      this.active = undefined;
      if (this.pending.length && !this.failed) this.schedule();
    });
  }

  private async drain(): Promise<void> {
    try {
      if (!this.file) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        this.file = await open(this.filename, 'wx', 0o600);
      }
      while (this.pending.length) {
        const batch = this.pending.splice(0, this.maxPending).join('');
        await this.file.appendFile(batch, 'utf8');
      }
    } catch {
      this.failed = true;
      this.pending.length = 0;
      try { await this.file?.close(); } catch { /* best effort */ }
      this.file = undefined;
    }
  }

  close(): Promise<void> {
    if (!this.shutdown) {
      this.closing = true;
      this.shutdown = (async () => {
        while (this.active) await this.active;
        try { await this.file?.close(); } catch { /* best effort */ }
        this.file = undefined;
      })();
    }
    return this.shutdown;
  }
}
