import type {
  OutgoingMessageInput,
  AckInput,
  StatusUpdateInput,
  SyncResponse,
  MessageEnvelope,
  StoredReceipt,
} from '../core/types.js';
import { calculateExponentialBackoffWithJitter, DEFAULT_TIMINGS } from '../core/timings.js';

export interface ClientConfig {
  baseUrl: string;
  token: string;
  endpointId: string;
  fetchFn?: typeof fetch;
}

export interface ClientOutboxItem {
  message: OutgoingMessageInput;
  enqueuedAt: number;
  attempts: number;
  lastAttemptAt?: number;
}

export class SwitchboardClient {
  private baseUrl: string;
  private token: string;
  public readonly endpointId: string;
  private fetchFn: typeof fetch;

  private outbox: ClientOutboxItem[] = [];
  private pendingAcks: AckInput[] = [];
  private currentStatus?: StatusUpdateInput;
  private cursor?: string;
  private inbox: MessageEnvelope[] = [];
  private isSyncing = false;
  private consecutiveFailures = 0;
  private lastError?: string;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
    this.endpointId = config.endpointId;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
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
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  /**
   * Enqueue outgoing message
   */
  queueMessage(message: OutgoingMessageInput): void {
    this.outbox.push({
      message,
      enqueuedAt: Date.now(),
      attempts: 0,
    });
  }

  /**
   * Enqueue explicit acknowledgement
   */
  queueAck(ack: AckInput): void {
    this.pendingAcks.push(ack);
  }

  /**
   * Set status update
   */
  setStatus(status: StatusUpdateInput): void {
    this.currentStatus = status;
  }

  /**
   * Send a single message directly via REST API
   */
  async sendMessageDirect(message: OutgoingMessageInput): Promise<StoredReceipt> {
    const res = await this.fetchFn(`${this.baseUrl}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(message),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any)?.error?.message ?? `Send failed: HTTP ${res.status}`);
    }

    return (await res.json()) as StoredReceipt;
  }

  /**
   * Perform a single sync cycle
   */
  async sync(): Promise<SyncResponse> {
    if (this.isSyncing) {
      throw new Error('Sync already in flight for this endpoint');
    }

    this.isSyncing = true;
    try {
      // Snapshot pending batch (bounded to 32)
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
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const errMsg = (errJson as any)?.error?.message ?? `Sync failed: HTTP ${res.status}`;
        this.lastError = errMsg;
        this.consecutiveFailures++;
        throw new Error(errMsg);
      }

      const syncRes = (await res.json()) as SyncResponse;

      // On commit: advance cursor, prune confirmed outbox items and acks
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

      return syncRes;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Starts an autonomous loop adapting its cadence to recommendedNextSyncMs
   */
  startAutonomousSync(
    onMessage?: (msg: MessageEnvelope) => void | Promise<void>,
    options?: { stopSignal?: AbortSignal }
  ): () => void {
    let running = true;
    let timer: any = null;

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

        if (onMessage && res.inboundMessages.length > 0) {
          for (const msg of res.inboundMessages) {
            try {
              await onMessage(msg);
            } catch (err) {
              console.error('Error in onMessage handler:', err);
            }
          }
        }
      } catch (err: any) {
        nextDelay = calculateExponentialBackoffWithJitter(this.consecutiveFailures);
      }

      if (running) {
        timer = setTimeout(loop, nextDelay);
      }
    };

    // Kick off first cycle
    loop();

    return () => {
      running = false;
      if (timer) clearTimeout(timer);
    };
  }
}
