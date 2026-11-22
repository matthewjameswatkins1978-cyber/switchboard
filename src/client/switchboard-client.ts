import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  OutgoingMessageInput,
  AckInput,
  StatusUpdateInput,
  SyncResponse,
  MessageEnvelope,
  StoredReceipt,
  AckReceipt,
  EndpointStatusRecord,
  BoardSummary,
  Priority,
  RecipientType,
} from '../core/types.js';
import { calculateExponentialBackoffWithJitter, DEFAULT_TIMINGS } from '../core/timings.js';

export function sanitizeErrorMessage(msg: string): string {
  if (!msg || typeof msg !== 'string') return '';
  return msg
    .replace(/Bearer\s+[a-zA-Z0-9_\-.~+/=]+/gi, 'Bearer [REDACTED]')
    .replace(/(token|key|secret)=([a-zA-Z0-9_\-.~+/=]+)/gi, '$1=[REDACTED]');
}

export interface ClientPersistedState {
  outbox: ClientOutboxItem[];
  pendingAcks: AckInput[];
  inbox: MessageEnvelope[];
  cursor?: string;
  status?: StatusUpdateInput;
  readMessageIds?: string[];
  acknowledgedMessageIds?: string[];
}

export interface ClientStorage {
  load(): Promise<ClientPersistedState | null> | ClientPersistedState | null;
  save(state: ClientPersistedState): Promise<void> | void;
  close?(): void;
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

  private withLock<T>(fn: () => T): T {
    const lockDir = `${this.filePath}.lock`;
    const timeout = Date.now() + 5000;
    while (true) {
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch (err: any) {
        if (err.code === 'EEXIST') {
          try {
            const stat = fs.statSync(lockDir);
            if (Date.now() - stat.mtimeMs > 10000) {
              fs.rmdirSync(lockDir);
              continue;
            }
          } catch {}
          if (Date.now() > timeout) {
            console.warn(`[FileClientStorage] Lock timeout on ${lockDir}, proceeding cautiously`);
            break;
          }
          const start = Date.now();
          while (Date.now() - start < 25) {}
        } else {
          break;
        }
      }
    }
    try {
      return fn();
    } finally {
      try {
        fs.rmdirSync(lockDir);
      } catch {}
    }
  }

  load(): ClientPersistedState | null {
    return this.withLock(() => {
      try {
        if (fs.existsSync(this.filePath)) {
          const raw = fs.readFileSync(this.filePath, 'utf8');
          return JSON.parse(raw);
        }
      } catch (err) {
        console.warn(`[FileClientStorage] Failed to read state file at ${this.filePath}:`, err);
      }
      return null;
    });
  }

  save(state: ClientPersistedState): void {
    this.withLock(() => {
      try {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const json = JSON.stringify(state, null, 2);
        const tempPath = `${this.filePath}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
        fs.writeFileSync(tempPath, json, 'utf8');
        try {
          fs.renameSync(tempPath, this.filePath);
        } catch {
          // Fallback if atomic rename fails on certain Windows file locks
          fs.copyFileSync(tempPath, this.filePath);
          try {
            fs.unlinkSync(tempPath);
          } catch {}
        }
      } catch (err) {
        console.error(`[FileClientStorage] Failed to write state file at ${this.filePath}:`, err);
      }
    });
  }
}

export class SqliteClientStorage implements ClientStorage {
  private filePath: string;
  private db: DatabaseSync;

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS client_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  load(): ClientPersistedState | null {
    try {
      const row = this.db.prepare('SELECT state_json FROM client_state WHERE id = 1').get() as
        | { state_json: string }
        | undefined;
      if (row?.state_json) {
        return JSON.parse(row.state_json);
      }
    } catch (err) {
      console.warn(`[SqliteClientStorage] Failed to read state from ${this.filePath}:`, err);
    }
    return null;
  }

  save(state: ClientPersistedState): void {
    try {
      const json = JSON.stringify(state);
      const now = Date.now();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db
          .prepare(
            `INSERT INTO client_state (id, state_json, updated_at)
             VALUES (1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`
          )
          .run(json, now);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      console.error(`[SqliteClientStorage] Failed to write state to ${this.filePath}:`, err);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {}
  }
}

export function createClientStorage(storagePath: string): ClientStorage {
  if (storagePath.endsWith('.sqlite') || storagePath.endsWith('.db')) {
    return new SqliteClientStorage(storagePath);
  }
  return new FileClientStorage(storagePath);
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
  private readMessageIds = new Set<string>();
  private acknowledgedMessageIds = new Set<string>();
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

  public reload(): void {
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
    if (Array.isArray(state.readMessageIds)) this.readMessageIds = new Set(state.readMessageIds);
    if (Array.isArray(state.acknowledgedMessageIds)) this.acknowledgedMessageIds = new Set(state.acknowledgedMessageIds);
  }

  private async persistState(): Promise<void> {
    const snapshot: ClientPersistedState = {
      outbox: [...this.outbox],
      pendingAcks: [...this.pendingAcks],
      inbox: [...this.inbox],
      cursor: this.cursor,
      status: this.currentStatus,
      readMessageIds: Array.from(this.readMessageIds),
      acknowledgedMessageIds: Array.from(this.acknowledgedMessageIds),
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
   * Helper to generate a unique client idempotency message ID
   */
  generateMessageId(prefix: string = 'msg'): string {
    const timestamp = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    return `${prefix}-${this.endpointId}-${timestamp}-${rand}`;
  }

  /**
   * Mark a local inbox message as read
   */
  markRead(messageId: string): void {
    this.readMessageIds.add(messageId);
    this.persistState();
  }

  /**
   * Check if a message has been read
   */
  isRead(messageId: string): boolean {
    return this.readMessageIds.has(messageId);
  }

  /**
   * Check if a message has been acknowledged
   */
  isAcknowledged(senderId: string, messageId: string): boolean {
    return this.acknowledgedMessageIds.has(`${senderId}:${messageId}`);
  }

  /**
   * Get unread messages from local inbox
   */
  getUnreadInbox(): MessageEnvelope[] {
    return this.inbox.filter((m) => !this.readMessageIds.has(m.id));
  }

  /**
   * Get a specific message from local inbox
   */
  getMessage(messageId: string): MessageEnvelope | undefined {
    return this.inbox.find((m) => m.id === messageId);
  }

  /**
   * Construct an addressed message input with auto-generated idempotency ID
   */
  createMessage(params: {
    recipientType?: RecipientType;
    recipientId: string;
    kind?: string;
    subject: string;
    payload: unknown;
    priority?: Priority;
    threadId?: string | null;
    replyToId?: string | null;
    evidenceRefs?: string[] | null;
    id?: string;
  }): OutgoingMessageInput {
    const msg: OutgoingMessageInput = {
      id: params.id ?? this.generateMessageId('msg'),
      recipientType: params.recipientType ?? 'endpoint',
      recipientId: params.recipientId,
      kind: params.kind ?? 'message.v1',
      subject: params.subject,
      payload: params.payload,
      priority: params.priority ?? 'normal',
    };
    if (params.threadId) msg.threadId = params.threadId;
    if (params.replyToId) msg.replyToId = params.replyToId;
    if (params.evidenceRefs && params.evidenceRefs.length > 0) {
      msg.evidenceRefs = params.evidenceRefs;
    }
    return msg;
  }

  /**
   * Construct a correlated reply to a received message
   */
  createReply(
    originalMessageId: string,
    reply: {
      subject?: string;
      payload: unknown;
      kind?: string;
      priority?: Priority;
      evidenceRefs?: string[] | null;
      id?: string;
    }
  ): OutgoingMessageInput {
    const original = this.getMessage(originalMessageId);
    const recipientId = original ? original.senderId : 'unknown';
    const threadId = original?.threadId ?? (original ? original.id : originalMessageId);
    const subject =
      reply.subject ??
      (original?.subject?.startsWith('Re: ')
        ? original.subject
        : `Re: ${original?.subject ?? originalMessageId}`);
    const kind = reply.kind ?? original?.kind ?? 'reply.v1';

    const msg: OutgoingMessageInput = {
      id: reply.id ?? this.generateMessageId('rep'),
      recipientType: 'endpoint',
      recipientId,
      kind,
      subject,
      payload: reply.payload,
      priority: reply.priority ?? original?.priority ?? 'normal',
      threadId,
      replyToId: originalMessageId,
    };
    if (reply.evidenceRefs && reply.evidenceRefs.length > 0) {
      msg.evidenceRefs = reply.evidenceRefs;
    }
    return msg;
  }

  /**
   * Enqueue a correlated reply
   */
  queueReply(
    originalMessageId: string,
    reply: {
      subject?: string;
      payload: unknown;
      kind?: string;
      priority?: Priority;
      evidenceRefs?: string[] | null;
      id?: string;
    }
  ): OutgoingMessageInput {
    const msg = this.createReply(originalMessageId, reply);
    this.queueMessage(msg);
    return msg;
  }

  /**
   * Acknowledge a message (queues ack and records local acknowledged state)
   */
  acknowledgeMessage(messageId: string, senderId: string, note?: string): void {
    this.queueAck({ messageId, senderId, note });
    this.acknowledgedMessageIds.add(`${senderId}:${messageId}`);
    this.markRead(messageId);
  }

  /**
   * Statistics snapshot of the local client state
   */
  getStats() {
    return {
      endpointId: this.endpointId,
      outboxCount: this.outbox.length,
      inboxCount: this.inbox.length,
      unreadCount: this.getUnreadInbox().length,
      pendingAckCount: this.pendingAcks.length,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      cursor: this.cursor,
    };
  }

  /**
   * Clear acknowledged messages from local inbox
   */
  clearAcknowledgedInbox(): void {
    this.inbox = this.inbox.filter((m) => !this.acknowledgedMessageIds.has(`${m.senderId}:${m.id}`));
    this.persistState();
  }

  /**
   * Fetch unacknowledged messages directly via GET /api/v1/inbox
   */
  async getInboxDirect(options?: { limit?: number; offset?: number }): Promise<MessageEnvelope[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const qs = params.toString() ? `?${params.toString()}` : '';

    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v1/inbox${qs}`, { method: 'GET' });
    return (await res.json()) as MessageEnvelope[];
  }

  /**
   * Send explicit acknowledgements directly via POST /api/v1/acknowledgements
   */
  async acknowledgeDirect(acks: AckInput | AckInput[]): Promise<AckReceipt[]> {
    const payload = Array.isArray(acks) ? acks : [acks];
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v1/acknowledgements`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    return (json as any).receipts as AckReceipt[];
  }

  /**
   * Fetch a single message directly via GET /api/v1/messages/:id
   */
  async getMessageDirect(messageId: string, senderId?: string): Promise<MessageEnvelope> {
    const qs = senderId ? `?senderId=${encodeURIComponent(senderId)}` : '';
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v1/messages/${encodeURIComponent(messageId)}${qs}`, {
      method: 'GET',
    });
    return (await res.json()) as MessageEnvelope;
  }

  /**
   * Fetch thread messages directly via GET /api/v1/threads/:id
   */
  async getThreadDirect(threadId: string, limit?: number): Promise<{ threadId: string; messages: MessageEnvelope[] }> {
    const qs = limit ? `?limit=${limit}` : '';
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v1/threads/${encodeURIComponent(threadId)}${qs}`, {
      method: 'GET',
    });
    return (await res.json()) as { threadId: string; messages: MessageEnvelope[] };
  }

  /**
   * List endpoints in project directly via GET /api/v1/endpoints
   */
  async listEndpointsDirect(): Promise<EndpointStatusRecord[]> {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v1/endpoints`, { method: 'GET' });
    const json = await res.json();
    return (json as any).endpoints as EndpointStatusRecord[];
  }

  /**
   * Get endpoint status directly via GET /api/v1/endpoints/:id/status
   */
  async getStatusDirect(endpointId: string): Promise<EndpointStatusRecord> {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v1/endpoints/${encodeURIComponent(endpointId)}/status`, {
      method: 'GET',
    });
    return (await res.json()) as EndpointStatusRecord;
  }

  /**
   * Update status directly via PUT /api/v1/status
   */
  async updateStatusDirect(status: StatusUpdateInput): Promise<EndpointStatusRecord> {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v1/status`, {
      method: 'PUT',
      body: JSON.stringify(status),
    });
    return (await res.json()) as EndpointStatusRecord;
  }

  /**
   * Get coordination board summary directly via GET /api/v1/board
   */
  async getBoardDirect(): Promise<BoardSummary> {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v1/board`, { method: 'GET' });
    return (await res.json()) as BoardSummary;
  }

  private async fetchWithAuth(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${this.token}`);
      if (init.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }

      const res = await this.fetchFn(url, {
        ...init,
        headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const rawMsg = (err as any)?.error?.message ?? `Request failed: HTTP ${res.status}`;
        throw new Error(sanitizeErrorMessage(rawMsg));
      }

      return res;
    } finally {
      clearTimeout(timer);
    }
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
        const rawMsg = (err as any)?.error?.message ?? `Send failed: HTTP ${res.status}`;
        throw new Error(sanitizeErrorMessage(rawMsg));
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
        const rawMsg = (errJson as any)?.error?.message ?? `Sync failed: HTTP ${res.status}`;
        const errMsg = sanitizeErrorMessage(rawMsg);
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
      for (const ack of syncRes.acknowledgedReceipts) {
        this.acknowledgedMessageIds.add(`${ack.senderId}:${ack.messageId}`);
      }

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
