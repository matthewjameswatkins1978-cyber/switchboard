import crypto from 'node:crypto';
import {
  SwitchboardClient,
  createClientStorage,
  type ClientStorage,
} from '../client/switchboard-client.js';
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
  EndpointState,
} from '../core/types.js';
import { resolvePlugConfig, type PlugConfig, type ResolvedPlugConfig } from './config.js';

export interface CompactMessageHeader {
  id: string;
  senderId: string;
  recipientId: string;
  recipientType: RecipientType;
  kind: string;
  subject: string;
  priority: Priority;
  serverCreatedAt: number;
  deliverySequence: number;
  isRead: boolean;
  isAcknowledged: boolean;
  replyToId?: string | null;
  threadId?: string | null;
}

export interface PlugIdentifyResult {
  role: string;
  endpointId: string;
  projectId: string;
  host: string;
  serverUrl: string;
  protocolVersion: number;
  storagePath: string;
  storageType: 'sqlite' | 'file' | 'memory';
  hasToken: boolean;
  tokenSha256?: string;
  stats: {
    outboxCount: number;
    inboxCount: number;
    unreadCount: number;
    pendingAckCount: number;
    consecutiveFailures: number;
    lastError?: string;
    cursor?: string;
  };
  status?: {
    state: EndpointState;
    description?: string | null;
  };
}

export class SwitchboardPlug {
  public readonly config: ResolvedPlugConfig;
  public readonly client: SwitchboardClient;
  private storage: ClientStorage;

  constructor(options?: Partial<PlugConfig>, storage?: ClientStorage) {
    this.config = resolvePlugConfig(options);
    this.storage = storage ?? createClientStorage(this.config.storagePath);
    this.client = new SwitchboardClient({
      baseUrl: this.config.baseUrl,
      token: this.config.token || '',
      endpointId: this.config.endpointId,
      storage: this.storage,
      timeoutMs: this.config.timeoutMs,
      autoFlushUrgent: this.config.autoFlushUrgent,
    });
  }

  /**
   * Return agent identity, host facts, and local mailbox stats
   */
  identify(): PlugIdentifyResult {
    const stats = this.client.getStats();
    const tokenSha256 = this.config.token
      ? crypto.createHash('sha256').update(this.config.token).digest('hex')
      : undefined;
    const isSqlite = this.config.storagePath.endsWith('.sqlite') || this.config.storagePath.endsWith('.db');
    return {
      role: `${this.config.endpointId}/plug`,
      endpointId: this.config.endpointId,
      projectId: this.config.projectId,
      host: `Antigravity 2.29.0 (${process.platform})`,
      serverUrl: this.config.baseUrl,
      protocolVersion: 1,
      storagePath: this.config.storagePath,
      storageType: isSqlite ? 'sqlite' : 'file',
      hasToken: this.config.hasToken,
      tokenSha256,
      stats,
    };
  }

  /**
   * Query inbox with progressive disclosure (compact headers by default)
   */
  async getInbox(options?: {
    unreadOnly?: boolean;
    limit?: number;
    offset?: number;
    syncFirst?: boolean;
  }): Promise<{
    messages: CompactMessageHeader[];
    total: number;
    unread: number;
  }> {
    if (options?.syncFirst && this.config.hasToken) {
      try {
        await this.client.sync();
      } catch (err) {
        console.warn('[SwitchboardPlug] Pre-inbox sync failed:', (err as Error).message);
      }
    }

    let all = this.client.getInbox();
    const unreadCount = this.client.getUnreadInbox().length;

    if (options?.unreadOnly) {
      all = all.filter((m) => !this.client.isRead(m.id));
    }

    // Sort newest first by serverCreatedAt/deliverySequence
    all.sort((a, b) => b.deliverySequence - a.deliverySequence);

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 32;
    const paged = all.slice(offset, offset + limit);

    const headers: CompactMessageHeader[] = paged.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      recipientId: m.recipientId,
      recipientType: m.recipientType,
      kind: m.kind,
      subject: m.subject,
      priority: m.priority,
      serverCreatedAt: m.serverCreatedAt,
      deliverySequence: m.deliverySequence,
      isRead: this.client.isRead(m.id),
      isAcknowledged: this.client.isAcknowledged(m.senderId, m.id),
      replyToId: m.replyToId,
      threadId: m.threadId,
    }));

    return {
      messages: headers,
      total: all.length,
      unread: unreadCount,
    };
  }

  /**
   * Read full message envelope by ID and mark read locally
   */
  readMessage(messageId: string): MessageEnvelope {
    const msg = this.client.getMessage(messageId);
    if (!msg) {
      throw new Error(`Message not found in local inbox: ${messageId}`);
    }
    this.client.markRead(messageId);
    return msg;
  }

  /**
   * Send an addressed message to an endpoint or channel
   */
  async sendMessage(options: {
    to: string;
    recipientType?: RecipientType;
    subject: string;
    payload: unknown;
    kind?: string;
    priority?: Priority;
    threadId?: string | null;
    replyToId?: string | null;
    evidenceRefs?: string[] | null;
    id?: string;
    immediate?: boolean;
  }): Promise<{ message: OutgoingMessageInput; receipt?: StoredReceipt }> {
    const msg = this.client.createMessage({
      recipientType: options.recipientType ?? 'endpoint',
      recipientId: options.to,
      subject: options.subject,
      payload: options.payload,
      kind: options.kind,
      priority: options.priority,
      threadId: options.threadId,
      replyToId: options.replyToId,
      evidenceRefs: options.evidenceRefs,
      id: options.id,
    });

    if (options.immediate && this.config.hasToken) {
      const receipt = await this.client.sendMessageDirect(msg);
      return { message: msg, receipt };
    }

    this.client.queueMessage(msg);

    if (msg.priority === 'urgent' && this.config.hasToken) {
      try {
        await this.client.sync();
      } catch {
        // queued for next retry
      }
    }

    return { message: msg };
  }

  /**
   * Send a correlated reply to a received message
   */
  async reply(options: {
    replyToId: string;
    subject?: string;
    payload: unknown;
    kind?: string;
    priority?: Priority;
    evidenceRefs?: string[] | null;
    id?: string;
    immediate?: boolean;
  }): Promise<{ message: OutgoingMessageInput; receipt?: StoredReceipt }> {
    const original = this.client.getMessage(options.replyToId);
    if (!original) {
      throw new Error(`Cannot reply: original message ${options.replyToId} not found in inbox`);
    }

    const replyMsg = this.client.createReply(options.replyToId, {
      subject: options.subject,
      payload: options.payload,
      kind: options.kind,
      priority: options.priority,
      evidenceRefs: options.evidenceRefs,
      id: options.id,
    });

    if (options.immediate && this.config.hasToken) {
      const receipt = await this.client.sendMessageDirect(replyMsg);
      return { message: replyMsg, receipt };
    }

    this.client.queueMessage(replyMsg);

    if (replyMsg.priority === 'urgent' && this.config.hasToken) {
      try {
        await this.client.sync();
      } catch {
        // queued for retry
      }
    }

    return { message: replyMsg };
  }

  /**
   * Explicitly acknowledge a message
   */
  async acknowledge(options: {
    messageId: string;
    senderId?: string;
    note?: string;
    immediate?: boolean;
  }): Promise<{ acknowledged: boolean; receipt?: AckReceipt }> {
    let senderId = options.senderId;
    if (!senderId) {
      const msg = this.client.getMessage(options.messageId);
      if (!msg) {
        throw new Error(
          `Cannot determine senderId for message ${options.messageId}; message not found in local inbox. Provide senderId explicitly.`
        );
      }
      senderId = msg.senderId;
    }

    const ackInput: AckInput = {
      messageId: options.messageId,
      senderId,
      note: options.note,
    };

    if (options.immediate && this.config.hasToken) {
      const receipts = await this.client.acknowledgeDirect(ackInput);
      this.client.markRead(options.messageId);
      return { acknowledged: true, receipt: receipts[0] };
    }

    this.client.acknowledgeMessage(options.messageId, senderId, options.note);
    return { acknowledged: true };
  }

  /**
   * Trigger an immediate sync cycle
   */
  async sync(): Promise<SyncResponse> {
    if (!this.config.hasToken) {
      throw new Error('Authentication token not configured. Set SWITCHBOARD_TOKEN.');
    }
    return await this.client.sync();
  }

  /**
   * Update operational presence status
   */
  async updateStatus(options: {
    state: EndpointState;
    description?: string;
    immediate?: boolean;
  }): Promise<void> {
    const updateInput: StatusUpdateInput = {
      state: options.state,
      description: options.description ?? null,
    };

    if (options.immediate && this.config.hasToken) {
      await this.client.updateStatusDirect(updateInput);
      return;
    }

    this.client.setStatus(updateInput);
  }

  /**
   * Discover registered endpoints in the project
   */
  async listEndpoints(): Promise<EndpointStatusRecord[]> {
    if (!this.config.hasToken) {
      throw new Error('Authentication token not configured. Set SWITCHBOARD_TOKEN.');
    }
    return await this.client.listEndpointsDirect();
  }

  /**
   * Fetch board coordination overview
   */
  async getBoard(): Promise<BoardSummary> {
    if (!this.config.hasToken) {
      throw new Error('Authentication token not configured. Set SWITCHBOARD_TOKEN.');
    }
    return await this.client.getBoardDirect();
  }

  /**
   * Start an adaptive background daemon
   */
  startDaemon(options?: {
    onMessage?: (msg: MessageEnvelope) => void | Promise<void>;
    stopSignal?: AbortSignal;
  }): () => void {
    if (!this.config.hasToken) {
      throw new Error('Authentication token not configured. Set SWITCHBOARD_TOKEN.');
    }
    return this.client.startAutonomousSync(options?.onMessage, {
      stopSignal: options?.stopSignal,
    });
  }
}
