import fs from 'node:fs';
import type {
  OutgoingMessageInput,
  AckInput,
  StatusUpdateInput,
  SyncResponse,
  MessageEnvelope,
  StoredReceipt,
} from '../core/types.js';
import { calculateExponentialBackoffWithJitter, DEFAULT_TIMINGS } from '../core/timings.js';

export interface ClientPersistedState {
  outbox: ClientOutboxItem[];
  pendingAcks: AckInput[];
  inbox: MessageEnvelope[];
  cursor?: string;
  status?: StatusUpdateInput;
}

export interface ClientStorage {
  load(): Promise<ClientPersistedState | null> | ClientPersistedState | null;
  save(state: ClientPersistedState): Promise<void> | void;
}

export class MemoryClientStorage implements ClientStorage {
  private state: ClientPersistedState | null = null;

  load(): ClientPersistedState | null {
    return this.state ? JSON.parse(JSON.stringify(this.state)) : null;
  }

  save(state: ClientPersistedState): void {
    this.state = JSON.parse(JSON.stringify(state));
  }
}

export class FileClientStorage implements ClientStorage {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): ClientPersistedState | null {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn(`[FileClientStorage] Failed to read state file at ${this.filePath}:`, err);
    }
    return null;
  }

  save(state: ClientPersistedState): void {
    try {
      const json = JSON.stringify(state, null, 2);
      fs.writeFileSync(this.filePath, json, 'utf8');
    } catch (err) {
      console.error(`[FileClientStorage] Failed to write state file at ${this.filePath}:`, err);
    }
  }
}

export interface ClientConfig {
  baseUrl: string;
  token: string;
  endpointId: string;
  fetchFn?: typeof fetch;
  storage?: ClientStorage;
  timeoutMs?: number;
  autoFlushUrgent?: boolean;
}

export interface ClientOutboxItem {
  message: OutgoingMessageInput;
  enqueuedAt: number;
  attempts: number;
  lastAttemptAt?: number;
}

function computeEndpointStagger(endpointId: string, maxMs = 3000): number {
  let hash = 0;
  for (let i = 0; i < endpointId.length; i++) {
    hash = (hash << 5) - hash + endpointId.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % maxMs;
}

export class SwitchboardClient {
  private baseUrl: string;
  private token: string;
  public readonly endpointId: string;
  private fetchFn: typeof fetch;
  private storage: ClientStorage;
  private timeoutMs: number;
  private autoFlushUrgent: boolean;

  private outbox: ClientOutboxItem[] = [];
  private pendingAcks: AckInput[] = [];
  private currentStatus?: StatusUpdateInput;
  private cursor?: string;
  private inbox: MessageEnvelope[] = [];
  private inFlightSync: Promise<SyncResponse> | null = null;
  private consecutiveFailures = 0;
  private lastError?: string;
  private retryAfterDelayMs = 0;
  private awaitingResponseStartMs?: number;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
    this.endpointId = config.endpointId;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
    this.storage = config.storage ?? new MemoryClientStorage();
    this.timeoutMs = config.timeoutMs ?? 15000;
    this.autoFlushUrgent = config.autoFlushUrgent ?? true;

    // Load persisted state if available
    const saved = this.storage.load();
    if (saved && typeof (saved as any).then === 'function') {
      (saved as Promise<ClientPersistedState | null>).then((loaded) => {
        if (loaded) this.applyLoadedState(loaded);
      });
    } else if (saved) {
      this.applyLoadedState(saved as ClientPersistedState);
    }
  }

  private applyLoadedState(state: ClientPersistedState) {
    if (Array.isArray(state.outbox)) this.outbox = [...state.outbox];
    if (Array.isArray(state.pendingAcks)) this.pendingAcks = [...state.pendingAcks];
    if (Array.isArray(state.inbox)) this.inbox = [...state.inbox];
    if (state.cursor !== undefined) this.cursor = state.cursor;
    if (state.status !== undefined) this.currentStatus = state.status;
  }

  private async persistState(): Promise<void> {
    const snapshot: ClientPersistedState = {
      outbox: [...this.outbox],
      pendingAcks: [...this.pendingAcks],
      inbox: [...this.inbox],
      cursor: this.cursor,
      status: this.currentStatus,
    };
    await this.storage.save(snapshot);
  }

  getOutbox(): ClientOutboxItem[] {
    return [...this.outbox];
  }

  getPendingAcks(): AckInput[] {
    return [...this.pendingAcks];
  }

  getInbox(): MessageEnvelope[] {
    return [...this.inbox];
  }

  getCursor(): string | undefined {
    return this.cursor;
  }

  setCursor(cursor: string): void {
    this.cursor = cursor;
    this.persistState();
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  /**
   * Enqueue outgoing message; auto-flushes immediately if urgent
   */
  queueMessage(message: OutgoingMessageInput): void {
    this.outbox.push({
      message,
      enqueuedAt: Date.now(),
      attempts: 0,
    });
    this.persistState();

    if (message.priority === 'urgent' && this.autoFlushUrgent && !this.inFlightSync) {
      // Trigger background immediate flush
      this.sync().catch(() => {});
    }
  }

  /**
   * Enqueue explicit acknowledgement
   */
  queueAck(ack: AckInput): void {
    this.pendingAcks.push(ack);
    this.persistState();
  }

  /**
   * Set status update
   */
  setStatus(status: StatusUpdateInput): void {
    this.currentStatus = status;
    if (status.state === 'waiting') {
      this.awaitingResponseStartMs = Date.now();
    } else {
      this.awaitingResponseStartMs = undefined;
    }
    this.persistState();
  }

  /**
   * Send a single message directly via REST API with timeout
   */
  async sendMessageDirect(message: OutgoingMessageInput): Promise<StoredReceipt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.error?.message ?? `Send failed: HTTP ${res.status}`);
      }

      return (await res.json()) as StoredReceipt;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Perform a single sync cycle with timeout and Retry-After handling.
   * Coalesces concurrent calls into the existing in-flight sync.
   */
  async sync(): Promise<SyncResponse> {
    if (this.inFlightSync) {
      return await this.inFlightSync;
    }
    this.inFlightSync = this.executeSync();
    try {
      return await this.inFlightSync;
    } finally {
      this.inFlightSync = null;
    }
  }

  private async executeSync(): Promise<SyncResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const outgoingToSend = this.outbox.slice(0, 32).map((item) => item.message);
      const acksToSend = this.pendingAcks.slice(0, 32);
      const statusToSend = this.currentStatus;

      const payload = {
        sinceCursor: this.cursor,
        outgoingMessages: outgoingToSend.length > 0 ? outgoingToSend : undefined,
        acknowledgements: acksToSend.length > 0 ? acksToSend : undefined,
        statusUpdate: statusToSend,
      };

      const res = await this.fetchFn(`${this.baseUrl}/api/v1/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      // Handle 429 Throttle & Retry-After header
      if (res.status === 429) {
        const retryAfterHeader = res.headers.get('Retry-After');
        const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : 5;
        this.retryAfterDelayMs = (Number.isFinite(retryAfterSec) ? retryAfterSec : 5) * 1000;
        this.consecutiveFailures++;
        this.lastError = 'THROTTLED: Server requested backoff';
        throw new Error(`Throttled: Retry after ${retryAfterSec}s`);
      }

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const errMsg = (errJson as any)?.error?.message ?? `Sync failed: HTTP ${res.status}`;
        this.lastError = errMsg;
        this.consecutiveFailures++;
        throw new Error(errMsg);
      }

      const syncRes = (await res.json()) as SyncResponse;

      // Reset retry-after on successful response
      this.retryAfterDelayMs = 0;
      this.cursor = syncRes.cursor;
      this.consecutiveFailures = 0;
      this.lastError = undefined;

      // Remove successfully stored messages from outbox
      const storedIds = new Set(syncRes.storedReceipts.map((r) => r.messageId));
      this.outbox = this.outbox.filter((item) => !storedIds.has(item.message.id));

      // Remove confirmed acks from queue
      const ackedIds = new Set(syncRes.acknowledgedReceipts.map((r) => `${r.senderId}:${r.messageId}`));
      this.pendingAcks = this.pendingAcks.filter(
        (ack) => !ackedIds.has(`${ack.senderId}:${ack.messageId}`)
      );

      // If status update succeeded, clear local intended update
      if (statusToSend && !syncRes.errors.some((e) => e.code === 'CONFLICT')) {
        this.currentStatus = undefined;
      }

      // Append new inbound messages
      for (const msg of syncRes.inboundMessages) {
        if (!this.inbox.some((existing) => existing.id === msg.id && existing.senderId === msg.senderId)) {
          this.inbox.push(msg);
        }
      }

      // Persist state to disk / storage
      await this.persistState();

      return syncRes;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Starts an autonomous loop adapting its cadence to recommendedNextSyncMs,
   * with stable per-endpoint stagger and Retry-After backoff.
   */
  startAutonomousSync(
    onMessage?: (msg: MessageEnvelope) => void | Promise<void>,
    options?: { stopSignal?: AbortSignal }
  ): () => void {
    let running = true;
    let timer: any = null;
    const staggerOffset = computeEndpointStagger(this.endpointId, 2500);

    if (options?.stopSignal) {
      if (options.stopSignal.aborted) {
        return () => {};
      }
      options.stopSignal.addEventListener('abort', () => {
        running = false;
        if (timer) clearTimeout(timer);
      });
    }

    const loop = async () => {
      if (!running) return;

      let nextDelay = DEFAULT_TIMINGS.activeInboxCadenceMs;
      try {
        const res = await this.sync();
        nextDelay = res.recommendedNextSyncMs;

        // Bounded awaiting response check
        if (this.awaitingResponseStartMs) {
          if (Date.now() - this.awaitingResponseStartMs > 120000) {
            this.awaitingResponseStartMs = undefined;
            nextDelay = DEFAULT_TIMINGS.activeInboxCadenceMs;
          } else {
            nextDelay = DEFAULT_TIMINGS.awaitingResponseCadenceMs;
          }
        }

        if (onMessage && res.inboundMessages.length > 0) {
          for (const msg of res.inboundMessages) {
            try {
              await onMessage(msg);
            } catch (err) {
              console.error('Error in onMessage handler:', err);
            }
          }
        }
      } catch {
        if (this.retryAfterDelayMs > 0) {
          nextDelay = this.retryAfterDelayMs;
        } else {
          nextDelay = calculateExponentialBackoffWithJitter(this.consecutiveFailures);
        }
      }

      if (running) {
        // Add staggered offset to prevent thundering herds across endpoints
        const totalDelay = nextDelay + (this.consecutiveFailures === 0 ? staggerOffset : 0);
        timer = setTimeout(loop, totalDelay);
      }
    };

    // Stagger initial cycle
    timer = setTimeout(loop, staggerOffset);

    return () => {
      running = false;
      if (timer) clearTimeout(timer);
    };
  }
}
