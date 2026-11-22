import type { DatabaseSession } from '../db/database.js';
import type {
  AuthPrincipal,
  OutgoingMessageInput,
  StoredReceipt,
  AckInput,
  AckReceipt,
  SyncRequest,
  SyncResponse,
  MessageEnvelope,
  StatusUpdateInput,
  EndpointStatusRecord,
  BoardSummary,
  ExportData,
  DeliveryStatus,
  SyncItemError,
  BackupRecord,
} from './types.js';
import { SwitchboardError } from './errors.js';
import {
  MAX_BODY_BYTES,
  MAX_BATCH_MESSAGES,
  MAX_AGGREGATE_BATCH_BYTES,
  OutgoingMessageInputSchema,
  SyncRequestSchema,
  StatusUpdateInputSchema,
} from './schema.js';
import { sha256 } from '../auth/auth-service.js';
import { calculateRecommendedNextSync, isPresenceStale } from './timings.js';
import { MetricsCollector } from './metrics.js';
import { BudgetManager } from '../operations/budget.js';

export async function computeEnvelopeHash(input: OutgoingMessageInput): Promise<string> {
  const canonical = JSON.stringify({
    recipientType: input.recipientType,
    recipientId: input.recipientId,
    kind: input.kind,
    subject: input.subject,
    payload: input.payload ?? null,
    priority: input.priority ?? 'normal',
    threadId: input.threadId ?? null,
    replyToId: input.replyToId ?? null,
    evidenceRefs: input.evidenceRefs ?? null,
  });
  return await sha256(canonical);
}

export class SwitchboardService {
  private db: DatabaseSession;
  private metrics: MetricsCollector;

  constructor(db: DatabaseSession, metrics: MetricsCollector = MetricsCollector.getInstance()) {
    this.db = db;
    this.metrics = metrics;
  }

  get database(): DatabaseSession {
    return this.db;
  }

  /**
   * Encodes a numeric sequence into an opaque cursor string
   */
  encodeCursor(seq: number): string {
    const json = JSON.stringify({ seq, v: 1 });
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(json, 'utf8').toString('base64');
    }
    return btoa(json);
  }

  /**
   * Decodes an opaque cursor string into a numeric sequence
   */
  decodeCursor(cursorStr?: string): number {
    if (!cursorStr) return 0;
    try {
      let json = '';
      if (typeof Buffer !== 'undefined') {
        json = Buffer.from(cursorStr, 'base64').toString('utf8');
      } else {
        json = atob(cursorStr);
      }
      const parsed = JSON.parse(json);
      if (typeof parsed.seq === 'number' && Number.isFinite(parsed.seq)) {
        return parsed.seq;
      }
      return 0;
    } catch {
      // If client passed a raw number string
      const num = Number(cursorStr);
      return Number.isFinite(num) ? num : 0;
    }
  }

  /**
   * Send a single message
   */
  async sendMessage(principal: AuthPrincipal, input: OutgoingMessageInput): Promise<StoredReceipt> {
    const start = Date.now();
    try {
      const validated = OutgoingMessageInputSchema.parse(input);
      const isUrgent = validated.priority === 'urgent';
      await BudgetManager.getInstance().enforceBudget(this.db, principal.projectId, isUrgent);

      const receipt = await this.db.transaction(async (tx) => {
        return await this.processSingleMessage(tx, principal, validated);
      });

      this.metrics.recordOperation({
        operation: 'send_message',
        outcome: 'success',
        durationMs: Date.now() - start,
        rowsWritten: receipt.recipientCount + 1,
      });

      await BudgetManager.getInstance().recordUsage(this.db, principal.projectId, {
        requests: 1,
        rowsWritten: receipt.recipientCount + 1,
      });

      return receipt;
    } catch (err: any) {
      this.metrics.recordOperation({
        operation: 'send_message',
        outcome: err instanceof SwitchboardError && err.code === 'CONFLICT' ? 'conflict' : 'error',
        durationMs: Date.now() - start,
      });
      throw err;
    }
  }

  private async processSingleMessage(
    tx: DatabaseSession,
    principal: AuthPrincipal,
    input: OutgoingMessageInput
  ): Promise<StoredReceipt> {
    const now = Date.now();
    const payloadStr = JSON.stringify(input.payload ?? null);
    const payloadBytes = new TextEncoder().encode(payloadStr).length;

    if (payloadBytes > MAX_BODY_BYTES) {
      throw new SwitchboardError(
        'PAYLOAD_TOO_LARGE',
        `Payload size (${payloadBytes} bytes) exceeds limit of ${MAX_BODY_BYTES} bytes`
      );
    }

    const payloadHash = await sha256(payloadStr);
    const envelopeHash = await computeEnvelopeHash(input);

    // 1. Check for existing message with (project_id, sender_id, id) for idempotency/conflict
    const existing = await tx.queryFirst<{
      id: string;
      payload_hash: string;
      envelope_hash: string;
      created_at: number;
    }>(
      `SELECT id, payload_hash, envelope_hash, created_at FROM messages
       WHERE project_id = ? AND sender_id = ? AND id = ?`,
      [principal.projectId, principal.endpointId, input.id]
    );

    if (existing) {
      if (existing.envelope_hash === envelopeHash) {
        // Idempotent duplicate: count deliveries and return stored receipt
        const countRow = await tx.queryFirst<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM message_deliveries
           WHERE project_id = ? AND sender_id = ? AND message_id = ?`,
          [principal.projectId, principal.endpointId, input.id]
        );
        this.metrics.recordDuplicateSuppressed();
        return {
          messageId: input.id,
          senderId: principal.endpointId,
          status: 'STORED',
          acceptedAt: existing.created_at,
          recipientCount: countRow?.cnt ?? 1,
          isDuplicate: true,
        };
      } else {
        // Conflict: same message ID reused with differing envelope content
        throw new SwitchboardError(
          'CONFLICT',
          `Message with id '${input.id}' already exists with differing envelope content`
        );
      }
    }

    // 2. Validate replyToId and visibility if provided
    if (input.replyToId) {
      const parent = await tx.queryFirst<{
        id: string;
        sender_id: string;
        recipient_type: string;
        recipient_id: string;
      }>(
        `SELECT id, sender_id, recipient_type, recipient_id FROM messages WHERE project_id = ? AND id = ?`,
        [principal.projectId, input.replyToId]
      );
      if (!parent) {
        throw new SwitchboardError(
          'NOT_FOUND',
          `Referenced reply_to_id message '${input.replyToId}' was not found in this project`
        );
      }

      let isVisible = false;
      if (parent.sender_id === principal.endpointId || parent.recipient_id === principal.endpointId) {
        isVisible = true;
      } else if (parent.recipient_type === 'channel') {
        const memberCheck = await tx.queryFirst<{ endpoint_id: string }>(
          `SELECT endpoint_id FROM channel_members WHERE channel_id = ? AND endpoint_id = ?`,
          [parent.recipient_id, principal.endpointId]
        );
        if (memberCheck) isVisible = true;
      }

      if (!isVisible) {
        throw new SwitchboardError(
          'FORBIDDEN',
          `Referenced reply_to_id message '${input.replyToId}' is not accessible to sender`
        );
      }
    }

    // 3. Resolve recipients
    let recipientEndpoints: string[] = [];
    let channelId: string | null = null;

    if (input.recipientType === 'endpoint') {
      const target = await tx.queryFirst<{ id: string }>(
        `SELECT id FROM endpoints WHERE project_id = ? AND id = ?`,
        [principal.projectId, input.recipientId]
      );
      if (!target) {
        throw new SwitchboardError(
          'NOT_FOUND',
          `Recipient endpoint '${input.recipientId}' not found in project '${principal.projectId}'`
        );
      }
      recipientEndpoints = [input.recipientId];
    } else if (input.recipientType === 'channel') {
      const channel = await tx.queryFirst<{ id: string }>(
        `SELECT id FROM channels WHERE project_id = ? AND id = ?`,
        [principal.projectId, input.recipientId]
      );
      if (!channel) {
        throw new SwitchboardError(
          'NOT_FOUND',
          `Channel '${input.recipientId}' not found in project '${principal.projectId}'`
        );
      }
      channelId = input.recipientId;

      // Verify sender is a member of the channel
      const senderMember = await tx.queryFirst<{ endpoint_id: string }>(
        `SELECT endpoint_id FROM channel_members WHERE channel_id = ? AND endpoint_id = ?`,
        [channelId, principal.endpointId]
      );
      if (!senderMember) {
        throw new SwitchboardError(
          'FORBIDDEN',
          `Sender '${principal.endpointId}' is not a member of channel '${channelId}'`
        );
      }

      // Atomic fanout resolution: resolve current members at acceptance time
      const members = await tx.query<{ endpoint_id: string }>(
        `SELECT endpoint_id FROM channel_members WHERE channel_id = ?`,
        [channelId]
      );
      recipientEndpoints = members.map((m) => m.endpoint_id);
    }

    // 4. Insert message
    await tx.execute(
      `INSERT INTO messages
       (id, sender_id, project_id, recipient_type, recipient_id, kind, subject,
        payload, payload_hash, envelope_hash, priority, thread_id, reply_to_id, evidence_refs, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        principal.endpointId,
        principal.projectId,
        input.recipientType,
        input.recipientId,
        input.kind,
        input.subject,
        payloadStr,
        payloadHash,
        envelopeHash,
        input.priority ?? 'normal',
        input.threadId ?? null,
        input.replyToId ?? null,
        input.evidenceRefs ? JSON.stringify(input.evidenceRefs) : null,
        now,
      ]
    );

    // 5. Create durable delivery records for each recipient endpoint with monotonic sequence
    for (const recipientId of recipientEndpoints) {
      const seqRow = await tx.queryFirst<{ max_seq: number | null }>(
        `SELECT MAX(sequence) as max_seq FROM message_deliveries
         WHERE project_id = ? AND recipient_id = ?`,
        [principal.projectId, recipientId]
      );
      const nextSeq = (seqRow?.max_seq ?? 0) + 1;

      await tx.execute(
        `INSERT INTO message_deliveries
         (project_id, message_id, sender_id, recipient_id, channel_id, sequence, status, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, 'STORED', ?)`,
        [principal.projectId, input.id, principal.endpointId, recipientId, channelId, nextSeq, now]
      );
    }

    this.metrics.recordMessageAccepted(1);

    return {
      messageId: input.id,
      senderId: principal.endpointId,
      status: 'STORED',
      acceptedAt: now,
      recipientCount: recipientEndpoints.length,
    };
  }

  /**
   * Batch synchronization: outbox, acknowledgements, status update, and inbound delivery
   */
  async sync(principal: AuthPrincipal, request: SyncRequest): Promise<SyncResponse> {
    const start = Date.now();
    try {
      const validated = SyncRequestSchema.parse(request);
      const hasUrgentOutbound = validated.outgoingMessages?.some((m) => m.priority === 'urgent') ?? false;
      await BudgetManager.getInstance().enforceBudget(this.db, principal.projectId, hasUrgentOutbound);
      const budgetReport = await BudgetManager.getInstance().getReport(this.db, principal.projectId);

      const result = await this.db.transaction(async (tx) => {
        const storedReceipts: StoredReceipt[] = [];
        const acknowledgedReceipts: AckReceipt[] = [];
        const errors: SyncItemError[] = [];

        // 1. Process outgoing messages
        if (validated.outgoingMessages && validated.outgoingMessages.length > 0) {
          for (const msg of validated.outgoingMessages) {
            try {
              const receipt = await this.processSingleMessage(tx, principal, msg);
              storedReceipts.push(receipt);
            } catch (err: any) {
              errors.push({
                id: msg.id,
                code: err instanceof SwitchboardError ? err.code : 'INVALID_INPUT',
                message: err.message ?? 'Failed to store message',
              });
            }
          }
        }

        // 2. Process acknowledgements
        if (validated.acknowledgements && validated.acknowledgements.length > 0) {
          for (const ack of validated.acknowledgements) {
            const now = Date.now();
            const delivery = await tx.queryFirst<{ id: number; status: DeliveryStatus }>(
              `SELECT id, status FROM message_deliveries
               WHERE project_id = ? AND recipient_id = ? AND sender_id = ? AND message_id = ?`,
              [principal.projectId, principal.endpointId, ack.senderId, ack.messageId]
            );

            if (delivery) {
              if (delivery.status !== 'ACKNOWLEDGED') {
                await tx.execute(
                  `UPDATE message_deliveries
                   SET status = 'ACKNOWLEDGED', acknowledged_at = ?, acknowledgement_note = ?
                   WHERE id = ?`,
                  [now, ack.note ?? null, delivery.id]
                );
                this.metrics.recordDeliveryAcknowledged();
              }
              acknowledgedReceipts.push({
                messageId: ack.messageId,
                senderId: ack.senderId,
                recipientId: principal.endpointId,
                status: 'ACKNOWLEDGED',
                acknowledgedAt: now,
              });
            } else {
              errors.push({
                id: ack.messageId,
                code: 'NOT_FOUND',
                message: `Delivery record not found for message '${ack.messageId}' from '${ack.senderId}'`,
              });
            }
          }
        }

        // 3. Process status update or piggybacked heartbeat
        const now = Date.now();
        if (validated.statusUpdate) {
          StatusUpdateInputSchema.parse(validated.statusUpdate);
          const currentStatus = await tx.queryFirst<{ revision: number }>(
            `SELECT revision FROM endpoint_status WHERE endpoint_id = ? AND project_id = ?`,
            [principal.endpointId, principal.projectId]
          );

          if (
            validated.statusUpdate.expectedRevision !== undefined &&
            currentStatus &&
            currentStatus.revision !== validated.statusUpdate.expectedRevision
          ) {
            errors.push({
              id: principal.endpointId,
              code: 'CONFLICT',
              message: `Status revision conflict: current revision is ${currentStatus.revision}, expected ${validated.statusUpdate.expectedRevision}`,
            });
          } else {
            await tx.execute(
              `INSERT INTO endpoint_status
               (endpoint_id, project_id, state, description, revision, last_heartbeat_at, updated_at, updated_by)
               VALUES (?, ?, ?, ?, 1, ?, ?, ?)
               ON CONFLICT(endpoint_id) DO UPDATE SET
                 state = excluded.state,
                 description = excluded.description,
                 revision = endpoint_status.revision + 1,
                 last_heartbeat_at = excluded.last_heartbeat_at,
                 updated_at = excluded.updated_at,
                 updated_by = excluded.updated_by`,
              [
                principal.endpointId,
                principal.projectId,
                validated.statusUpdate.state,
                validated.statusUpdate.description ?? null,
                now,
                now,
                principal.endpointId,
              ]
            );
          }
        } else {
          // Automatic heartbeat update on sync
          await tx.execute(
            `UPDATE endpoint_status SET last_heartbeat_at = ?
             WHERE endpoint_id = ? AND project_id = ?`,
            [now, principal.endpointId, principal.projectId]
          );
        }

        // 4. Retrieve inbound messages
        const fromSeq = this.decodeCursor(validated.sinceCursor);
        const limit = Math.min(validated.limit ?? MAX_BATCH_MESSAGES, MAX_BATCH_MESSAGES);

        // Monotonic sequence query
        let querySql = `
          SELECT
            m.id, m.sender_id, m.project_id, m.recipient_type, m.recipient_id,
            m.kind, m.subject, m.payload, m.priority, m.thread_id, m.reply_to_id,
            m.evidence_refs, m.created_at,
            d.sequence, d.status, d.acknowledged_at
          FROM message_deliveries d
          JOIN messages m ON d.project_id = m.project_id AND d.sender_id = m.sender_id AND d.message_id = m.id
          WHERE d.project_id = ? AND d.recipient_id = ? AND d.sequence > ?
        `;

        if (!validated.includeAcknowledged) {
          querySql += ` AND d.status != 'ACKNOWLEDGED'`;
        }

        querySql += ` ORDER BY d.sequence ASC LIMIT ?`;

        const rows = await tx.query<any>(querySql, [
          principal.projectId,
          principal.endpointId,
          fromSeq,
          limit + 1, // +1 to check hasMore
        ]);

        const hasMore = rows.length > limit;
        const pageRows = rows.slice(0, limit);

        let maxSeqSeen = fromSeq;
        let aggregateBytes = 0;
        const inboundMessages: MessageEnvelope[] = [];
        let hasUrgentInbound = false;

        for (const r of pageRows) {
          let payload: unknown = null;
          try {
            payload = JSON.parse(r.payload);
          } catch {
            payload = r.payload;
          }

          let evidenceRefs: string[] | null = null;
          if (r.evidence_refs) {
            try {
              evidenceRefs = JSON.parse(r.evidence_refs);
            } catch {
              evidenceRefs = null;
            }
          }

          const envelope: MessageEnvelope = {
            id: r.id,
            senderId: r.sender_id,
            projectId: r.project_id,
            recipientType: r.recipient_type,
            recipientId: r.recipient_id,
            kind: r.kind,
            subject: r.subject,
            payload,
            priority: r.priority,
            threadId: r.thread_id,
            replyToId: r.reply_to_id,
            evidenceRefs,
            serverCreatedAt: r.created_at,
            deliverySequence: r.sequence,
            deliveryStatus: r.status,
            acknowledgedAt: r.acknowledged_at,
          };

          const envBytes = new TextEncoder().encode(JSON.stringify(envelope)).length;
          if (aggregateBytes + envBytes > MAX_AGGREGATE_BATCH_BYTES && inboundMessages.length > 0) {
            // Aggregate byte ceiling reached
            break;
          }

          aggregateBytes += envBytes;
          inboundMessages.push(envelope);
          if (r.sequence > maxSeqSeen) {
            maxSeqSeen = r.sequence;
          }
          if (r.priority === 'urgent') {
            hasUrgentInbound = true;
          }
        }

        // Check if urgent outgoing occurred
        const hasUrgentOutbound = validated.outgoingMessages?.some((m) => m.priority === 'urgent');

        // Check current endpoint state
        const statusRecord = await tx.queryFirst<{ state: any }>(
          `SELECT state FROM endpoint_status WHERE endpoint_id = ? AND project_id = ?`,
          [principal.endpointId, principal.projectId]
        );

        const baseRecommendedNextSyncMs = calculateRecommendedNextSync({
          endpointState: statusRecord?.state ?? 'available',
          hasUrgentActivity: hasUrgentInbound || hasUrgentOutbound,
          hasUnreadMessages: inboundMessages.length > 0,
          now,
        });

        const recommendedNextSyncMs = Math.round(
          baseRecommendedNextSyncMs * budgetReport.cadenceMultiplier
        );

        const nextCursor = this.encodeCursor(maxSeqSeen);

        return {
          storedReceipts,
          acknowledgedReceipts,
          inboundMessages,
          errors,
          cursor: nextCursor,
          hasMore,
          serverTime: now,
          recommendedNextSyncMs,
        };
      });

      this.metrics.recordOperation({
        operation: 'sync',
        outcome: 'success',
        durationMs: Date.now() - start,
        rowsRead: result.inboundMessages.length,
        rowsWritten: result.storedReceipts.length + result.acknowledgedReceipts.length,
      });

      await BudgetManager.getInstance().recordUsage(this.db, principal.projectId, {
        requests: 1,
        rowsRead: result.inboundMessages.length,
        rowsWritten: result.storedReceipts.length + result.acknowledgedReceipts.length,
      });

      return result;
    } catch (err: any) {
      this.metrics.recordOperation({
        operation: 'sync',
        outcome: 'error',
        durationMs: Date.now() - start,
      });
      throw err;
    }
  }

  /**
   * Bounded read-only view of unacknowledged deliveries
   */
  async getInbox(
    principal: AuthPrincipal,
    options?: { limit?: number; offset?: number }
  ): Promise<{ deliveries: MessageEnvelope[]; total: number }> {
    const limit = Math.min(options?.limit ?? MAX_BATCH_MESSAGES, MAX_BATCH_MESSAGES);
    const offset = options?.offset ?? 0;

    const totalRow = await this.db.queryFirst<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM message_deliveries
       WHERE project_id = ? AND recipient_id = ? AND status != 'ACKNOWLEDGED'`,
      [principal.projectId, principal.endpointId]
    );

    const rows = await this.db.query<any>(
      `SELECT
         m.id, m.sender_id, m.project_id, m.recipient_type, m.recipient_id,
         m.kind, m.subject, m.payload, m.priority, m.thread_id, m.reply_to_id,
         m.evidence_refs, m.created_at,
         d.sequence, d.status, d.acknowledged_at
       FROM message_deliveries d
       JOIN messages m ON d.project_id = m.project_id AND d.sender_id = m.sender_id AND d.message_id = m.id
       WHERE d.project_id = ? AND d.recipient_id = ? AND d.status != 'ACKNOWLEDGED'
       ORDER BY d.sequence ASC
       LIMIT ? OFFSET ?`,
      [principal.projectId, principal.endpointId, limit, offset]
    );

    const deliveries: MessageEnvelope[] = rows.map((r) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(r.payload);
      } catch {
        payload = r.payload;
      }
      return {
        id: r.id,
        senderId: r.sender_id,
        projectId: r.project_id,
        recipientType: r.recipient_type,
        recipientId: r.recipient_id,
        kind: r.kind,
        subject: r.subject,
        payload,
        priority: r.priority,
        threadId: r.thread_id,
        replyToId: r.reply_to_id,
        evidenceRefs: r.evidence_refs ? JSON.parse(r.evidence_refs) : null,
        serverCreatedAt: r.created_at,
        deliverySequence: r.sequence,
        deliveryStatus: r.status,
        acknowledgedAt: r.acknowledged_at,
      };
    });

    return {
      deliveries,
      total: totalRow?.cnt ?? 0,
    };
  }

  /**
   * Explicit acknowledgement of deliveries (repeat-safe)
   */
  async acknowledge(principal: AuthPrincipal, acks: AckInput[]): Promise<AckReceipt[]> {
    const start = Date.now();
    try {
      const results = await this.db.transaction(async (tx) => {
        const receipts: AckReceipt[] = [];
        const now = Date.now();

        for (const ack of acks) {
          const delivery = await tx.queryFirst<{ id: number; status: DeliveryStatus }>(
            `SELECT id, status FROM message_deliveries
             WHERE project_id = ? AND recipient_id = ? AND sender_id = ? AND message_id = ?`,
            [principal.projectId, principal.endpointId, ack.senderId, ack.messageId]
          );

          if (!delivery) {
            throw new SwitchboardError(
              'NOT_FOUND',
              `Delivery not found for message '${ack.messageId}' from sender '${ack.senderId}'`
            );
          }

          if (delivery.status !== 'ACKNOWLEDGED') {
            await tx.execute(
              `UPDATE message_deliveries
               SET status = 'ACKNOWLEDGED', acknowledged_at = ?, acknowledgement_note = ?
               WHERE id = ?`,
              [now, ack.note ?? null, delivery.id]
            );
            this.metrics.recordDeliveryAcknowledged();
          }

          receipts.push({
            messageId: ack.messageId,
            senderId: ack.senderId,
            recipientId: principal.endpointId,
            status: 'ACKNOWLEDGED',
            acknowledgedAt: now,
          });
        }

        return receipts;
      });

      this.metrics.recordOperation({
        operation: 'acknowledge',
        outcome: 'success',
        durationMs: Date.now() - start,
        rowsWritten: results.length,
      });

      return results;
    } catch (err: any) {
      this.metrics.recordOperation({
        operation: 'acknowledge',
        outcome: 'error',
        durationMs: Date.now() - start,
      });
      throw err;
    }
  }

  /**
   * Get authorized message by ID
   */
  async getMessage(
    principal: AuthPrincipal,
    messageId: string,
    senderId?: string
  ): Promise<MessageEnvelope> {
    let sql = `
      SELECT
        m.id, m.sender_id, m.project_id, m.recipient_type, m.recipient_id,
        m.kind, m.subject, m.payload, m.priority, m.thread_id, m.reply_to_id,
        m.evidence_refs, m.created_at,
        d.sequence, d.status, d.acknowledged_at
      FROM messages m
      LEFT JOIN message_deliveries d
        ON d.project_id = m.project_id AND d.sender_id = m.sender_id AND d.message_id = m.id
        AND d.recipient_id = ?
      WHERE m.project_id = ? AND m.id = ?
    `;

    const queryParams: any[] = [principal.endpointId, principal.projectId, messageId];
    if (senderId) {
      sql += ` AND m.sender_id = ?`;
      queryParams.push(senderId);
    }

    const row = await this.db.queryFirst<any>(sql, queryParams);
    if (!row) {
      throw new SwitchboardError('NOT_FOUND', `Message '${messageId}' not found`);
    }

    // Verify visibility: principal must be sender, recipient, or member of channel
    if (row.sender_id !== principal.endpointId && row.recipient_id !== principal.endpointId) {
      if (row.recipient_type === 'channel') {
        const isMember = await this.db.queryFirst<{ channel_id: string }>(
          `SELECT channel_id FROM channel_members WHERE channel_id = ? AND endpoint_id = ?`,
          [row.recipient_id, principal.endpointId]
        );
        if (!isMember) {
          throw new SwitchboardError('FORBIDDEN', 'Access to channel message denied');
        }
      } else {
        throw new SwitchboardError('FORBIDDEN', 'Access to message denied');
      }
    }

    let payload: unknown = null;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = row.payload;
    }

    return {
      id: row.id,
      senderId: row.sender_id,
      projectId: row.project_id,
      recipientType: row.recipient_type,
      recipientId: row.recipient_id,
      kind: row.kind,
      subject: row.subject,
      payload,
      priority: row.priority,
      threadId: row.thread_id,
      replyToId: row.reply_to_id,
      evidenceRefs: row.evidence_refs ? JSON.parse(row.evidence_refs) : null,
      serverCreatedAt: row.created_at,
      deliverySequence: row.sequence ?? 0,
      deliveryStatus: row.status ?? 'STORED',
      acknowledgedAt: row.acknowledged_at,
    };
  }

  /**
   * Get thread messages
   */
  async getThread(
    principal: AuthPrincipal,
    threadId: string,
    limit = 50
  ): Promise<MessageEnvelope[]> {
    const rows = await this.db.query<any>(
      `SELECT
         m.id, m.sender_id, m.project_id, m.recipient_type, m.recipient_id,
         m.kind, m.subject, m.payload, m.priority, m.thread_id, m.reply_to_id,
         m.evidence_refs, m.created_at,
         d.sequence, d.status, d.acknowledged_at
       FROM messages m
       LEFT JOIN message_deliveries d
         ON d.project_id = m.project_id AND d.sender_id = m.sender_id AND d.message_id = m.id
         AND d.recipient_id = ?
       WHERE m.project_id = ? AND (m.thread_id = ? OR m.id = ?)
       ORDER BY m.created_at ASC
       LIMIT ?`,
      [principal.endpointId, principal.projectId, threadId, threadId, limit]
    );

    return rows.map((r) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(r.payload);
      } catch {
        payload = r.payload;
      }
      return {
        id: r.id,
        senderId: r.sender_id,
        projectId: r.project_id,
        recipientType: r.recipient_type,
        recipientId: r.recipient_id,
        kind: r.kind,
        subject: r.subject,
        payload,
        priority: r.priority,
        threadId: r.thread_id,
        replyToId: r.reply_to_id,
        evidenceRefs: r.evidence_refs ? JSON.parse(r.evidence_refs) : null,
        serverCreatedAt: r.created_at,
        deliverySequence: r.sequence ?? 0,
        deliveryStatus: r.status ?? 'STORED',
        acknowledgedAt: r.acknowledged_at,
      };
    });
  }

  /**
   * List endpoints in project and check stale presence
   */
  async listEndpoints(principal: AuthPrincipal): Promise<EndpointStatusRecord[]> {
    const rows = await this.db.query<any>(
      `SELECT e.id as endpoint_id, e.project_id, s.state, s.description,
              s.revision, s.last_heartbeat_at, s.updated_at, s.updated_by
       FROM endpoints e
       LEFT JOIN endpoint_status s ON e.id = s.endpoint_id AND e.project_id = s.project_id
       WHERE e.project_id = ?
       ORDER BY e.id ASC`,
      [principal.projectId]
    );

    const now = Date.now();
    return rows.map((r) => {
      const lastHb = r.last_heartbeat_at ?? r.updated_at ?? 0;
      const stale = isPresenceStale(lastHb, now);
      return {
        endpointId: r.endpoint_id,
        projectId: r.project_id,
        state: stale && r.state !== 'offline' ? 'stale' : r.state ?? 'available',
        description: r.description ?? null,
        revision: r.revision ?? 1,
        lastHeartbeatAt: lastHb,
        updatedAt: r.updated_at ?? now,
        updatedBy: r.updated_by ?? r.endpoint_id,
        isStale: stale,
      };
    });
  }

  /**
   * Get single endpoint status
   */
  async getStatus(principal: AuthPrincipal, endpointId: string): Promise<EndpointStatusRecord> {
    const row = await this.db.queryFirst<any>(
      `SELECT endpoint_id, project_id, state, description, revision, last_heartbeat_at, updated_at, updated_by
       FROM endpoint_status
       WHERE endpoint_id = ? AND project_id = ?`,
      [endpointId, principal.projectId]
    );

    if (!row) {
      throw new SwitchboardError('NOT_FOUND', `Endpoint '${endpointId}' status not found`);
    }

    const now = Date.now();
    const stale = isPresenceStale(row.last_heartbeat_at, now);

    return {
      endpointId: row.endpoint_id,
      projectId: row.project_id,
      state: stale && row.state !== 'offline' ? 'stale' : row.state,
      description: row.description,
      revision: row.revision,
      lastHeartbeatAt: row.last_heartbeat_at,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      isStale: stale,
    };
  }

  /**
   * Update latest status snapshot with optimistic concurrency check
   */
  async updateStatus(
    principal: AuthPrincipal,
    input: StatusUpdateInput
  ): Promise<EndpointStatusRecord> {
    const validated = StatusUpdateInputSchema.parse(input);
    const now = Date.now();

    await this.db.transaction(async (tx) => {
      const existing = await tx.queryFirst<{ revision: number }>(
        `SELECT revision FROM endpoint_status WHERE endpoint_id = ? AND project_id = ?`,
        [principal.endpointId, principal.projectId]
      );

      if (
        validated.expectedRevision !== undefined &&
        existing &&
        existing.revision !== validated.expectedRevision
      ) {
        throw new SwitchboardError(
          'CONFLICT',
          `Revision conflict: expected ${validated.expectedRevision}, current is ${existing.revision}`
        );
      }

      await tx.execute(
        `INSERT INTO endpoint_status
         (endpoint_id, project_id, state, description, revision, last_heartbeat_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(endpoint_id) DO UPDATE SET
           state = excluded.state,
           description = excluded.description,
           revision = endpoint_status.revision + 1,
           last_heartbeat_at = excluded.last_heartbeat_at,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
        [
          principal.endpointId,
          principal.projectId,
          validated.state,
          validated.description ?? null,
          now,
          now,
          principal.endpointId,
        ]
      );
    });

    return await this.getStatus(principal, principal.endpointId);
  }

  /**
   * Get coordination board overview
   */
  async getBoard(principal: AuthPrincipal): Promise<BoardSummary> {
    const endpoints = await this.listEndpoints(principal);

    const unackedRow = await this.db.queryFirst<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM message_deliveries
       WHERE project_id = ? AND status != 'ACKNOWLEDGED'`,
      [principal.projectId]
    );

    const recentRows = await this.db.query<any>(
      `SELECT
         m.id, m.sender_id, m.project_id, m.recipient_type, m.recipient_id,
         m.kind, m.subject, m.payload, m.priority, m.thread_id, m.reply_to_id,
         m.evidence_refs, m.created_at,
         d.sequence, d.status, d.acknowledged_at
       FROM messages m
       LEFT JOIN message_deliveries d
         ON d.project_id = m.project_id AND d.sender_id = m.sender_id AND d.message_id = m.id
       WHERE m.project_id = ?
       ORDER BY m.created_at DESC
       LIMIT 20`,
      [principal.projectId]
    );

    const recentMessages: MessageEnvelope[] = recentRows.map((r) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(r.payload);
      } catch {
        payload = r.payload;
      }
      return {
        id: r.id,
        senderId: r.sender_id,
        projectId: r.project_id,
        recipientType: r.recipient_type,
        recipientId: r.recipient_id,
        kind: r.kind,
        subject: r.subject,
        payload,
        priority: r.priority,
        threadId: r.thread_id,
        replyToId: r.reply_to_id,
        evidenceRefs: r.evidence_refs ? JSON.parse(r.evidence_refs) : null,
        serverCreatedAt: r.created_at,
        deliverySequence: r.sequence ?? 0,
        deliveryStatus: r.status ?? 'STORED',
        acknowledgedAt: r.acknowledged_at,
      };
    });

    const errorRows = await this.db.query<any>(
      `SELECT id, action, details, created_at FROM audit_log
       WHERE project_id = ? AND action LIKE '%error%'
       ORDER BY id DESC LIMIT 10`,
      [principal.projectId]
    );

    return {
      projectId: principal.projectId,
      serverTime: Date.now(),
      endpoints,
      unackedCount: unackedRow?.cnt ?? 0,
      recentMessages,
      recentErrors: errorRows.map((e) => ({
        id: e.id,
        action: e.action,
        details: e.details,
        createdAt: e.created_at,
      })),
    };
  }

  /**
   * Export all data for project with checksum
   */
  async exportData(principal: AuthPrincipal): Promise<ExportData> {
    const projects = await this.db.query<any>(`SELECT id, name, created_at FROM projects WHERE id = ?`, [
      principal.projectId,
    ]);
    const endpoints = await this.db.query<any>(
      `SELECT id, project_id, name, role, created_at FROM endpoints WHERE project_id = ?`,
      [principal.projectId]
    );
    const channels = await this.db.query<any>(
      `SELECT id, project_id, name, created_at FROM channels WHERE project_id = ?`,
      [principal.projectId]
    );
    const channelMembers = await this.db.query<any>(
      `SELECT cm.channel_id, cm.endpoint_id, cm.joined_at
       FROM channel_members cm
       JOIN channels c ON cm.channel_id = c.id
       WHERE c.project_id = ?`,
      [principal.projectId]
    );
    const messages = await this.db.query<any>(
      `SELECT id, sender_id, project_id, recipient_type, recipient_id, kind, subject,
              payload, payload_hash, envelope_hash, priority, thread_id, reply_to_id, evidence_refs, created_at
       FROM messages WHERE project_id = ? ORDER BY internal_id ASC`,
      [principal.projectId]
    );
    const deliveries = await this.db.query<any>(
      `SELECT id, project_id, message_id, sender_id, recipient_id, channel_id,
              sequence, status, delivered_at, received_at, acknowledged_at, acknowledgement_note
       FROM message_deliveries WHERE project_id = ? ORDER BY id ASC`,
      [principal.projectId]
    );
    const statuses = await this.db.query<any>(
      `SELECT endpoint_id, project_id, state, description, revision, last_heartbeat_at, updated_at, updated_by
       FROM endpoint_status WHERE project_id = ?`,
      [principal.projectId]
    );

    const exportPayload: Omit<ExportData, 'checksumSha256'> = {
      version: '0.1.0',
      exportedAt: Date.now(),
      projectId: principal.projectId,
      projects: projects.map((p) => ({ id: p.id, name: p.name, createdAt: p.created_at })),
      endpoints: endpoints.map((e) => ({
        id: e.id,
        projectId: e.project_id,
        name: e.name,
        role: e.role,
        createdAt: e.created_at,
      })),
      channels: channels.map((c) => ({ id: c.id, projectId: c.project_id, name: c.name, createdAt: c.created_at })),
      channelMembers: channelMembers.map((cm) => ({
        channelId: cm.channel_id,
        endpointId: cm.endpoint_id,
        joinedAt: cm.joined_at,
      })),
      messages: messages.map((m) => ({
        id: m.id,
        senderId: m.sender_id,
        projectId: m.project_id,
        recipientType: m.recipient_type,
        recipientId: m.recipient_id,
        kind: m.kind,
        subject: m.subject,
        payload: m.payload,
        payloadHash: m.payload_hash,
        envelopeHash: m.envelope_hash ?? m.payload_hash,
        priority: m.priority,
        threadId: m.thread_id,
        replyToId: m.reply_to_id,
        evidenceRefs: m.evidence_refs ? JSON.parse(m.evidence_refs) : null,
        createdAt: m.created_at,
      })),
      deliveries: deliveries.map((d) => ({
        id: d.id,
        projectId: d.project_id,
        messageId: d.message_id,
        senderId: d.sender_id,
        recipientId: d.recipient_id,
        channelId: d.channel_id,
        sequence: d.sequence,
        status: d.status,
        deliveredAt: d.delivered_at,
        receivedAt: d.received_at,
        acknowledgedAt: d.acknowledged_at,
        acknowledgementNote: d.acknowledgement_note,
      })),
      statuses: statuses.map((s) => ({
        endpointId: s.endpoint_id,
        projectId: s.project_id,
        state: s.state,
        description: s.description,
        revision: s.revision,
        lastHeartbeatAt: s.last_heartbeat_at,
        updatedAt: s.updated_at,
        updatedBy: s.updated_by,
      })),
    };

    const checksum = await sha256(JSON.stringify(exportPayload));
    return {
      ...exportPayload,
      checksumSha256: checksum,
    };
  }

  /**
   * Import data and restore state with integrity verification
   */
  async importData(principal: AuthPrincipal, data: ExportData): Promise<{ importedCount: number }> {
    const { checksumSha256, ...dataWithoutChecksum } = data;
    const computedChecksum = await sha256(JSON.stringify(dataWithoutChecksum));

    if (checksumSha256 !== computedChecksum) {
      throw new SwitchboardError(
        'INVALID_INPUT',
        'Data integrity failure: checksum mismatch during import'
      );
    }

    if (data.projectId !== principal.projectId && principal.role !== 'admin') {
      throw new SwitchboardError(
        'FORBIDDEN',
        `Cannot import data for project '${data.projectId}' under project '${principal.projectId}'`
      );
    }

    let count = 0;
    await this.db.transaction(async (tx) => {
      // 1. Projects
      for (const p of data.projects) {
        await tx.execute(
          `INSERT OR REPLACE INTO projects (id, name, created_at) VALUES (?, ?, ?)`,
          [p.id, p.name, p.createdAt]
        );
      }

      // 2. Endpoints
      for (const e of data.endpoints) {
        await tx.execute(
          `INSERT OR REPLACE INTO endpoints (id, project_id, name, role, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [e.id, e.projectId, e.name, e.role, e.createdAt]
        );
      }

      // 3. Channels
      for (const c of data.channels) {
        await tx.execute(
          `INSERT OR REPLACE INTO channels (id, project_id, name, created_at)
           VALUES (?, ?, ?, ?)`,
          [c.id, c.projectId, c.name, c.createdAt]
        );
      }

      // 4. Channel Members
      for (const cm of data.channelMembers) {
        await tx.execute(
          `INSERT OR REPLACE INTO channel_members (channel_id, endpoint_id, joined_at)
           VALUES (?, ?, ?)`,
          [cm.channelId, cm.endpointId, cm.joinedAt]
        );
      }

      // 5. Messages
      for (const m of data.messages) {
        await tx.execute(
          `INSERT OR REPLACE INTO messages
           (id, sender_id, project_id, recipient_type, recipient_id, kind, subject,
            payload, payload_hash, envelope_hash, priority, thread_id, reply_to_id, evidence_refs, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            m.id,
            m.senderId,
            m.projectId,
            m.recipientType,
            m.recipientId,
            m.kind,
            m.subject,
            m.payload,
            m.payloadHash,
            m.envelopeHash ?? m.payloadHash,
            m.priority,
            m.threadId ?? null,
            m.replyToId ?? null,
            m.evidenceRefs ? JSON.stringify(m.evidenceRefs) : null,
            m.createdAt,
          ]
        );
        count++;
      }

      // 6. Deliveries
      for (const d of data.deliveries) {
        await tx.execute(
          `INSERT OR REPLACE INTO message_deliveries
           (id, project_id, message_id, sender_id, recipient_id, channel_id, sequence, status, delivered_at, received_at, acknowledged_at, acknowledgement_note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            d.id,
            d.projectId,
            d.messageId,
            d.senderId,
            d.recipientId,
            d.channelId ?? null,
            d.sequence,
            d.status,
            d.deliveredAt,
            d.receivedAt ?? null,
            d.acknowledgedAt ?? null,
            d.acknowledgementNote ?? null,
          ]
        );
      }

      // 7. Statuses
      for (const s of data.statuses) {
        await tx.execute(
          `INSERT OR REPLACE INTO endpoint_status
           (endpoint_id, project_id, state, description, revision, last_heartbeat_at, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            s.endpointId,
            s.projectId,
            s.state,
            s.description ?? null,
            s.revision,
            s.lastHeartbeatAt,
            s.updatedAt,
            s.updatedBy,
          ]
        );
      }
    });

    return { importedCount: count };
  }

  /**
   * Helper to create a channel and add initial members
   */
  async createChannel(
    principal: AuthPrincipal,
    channelId: string,
    name: string,
    initialMembers: string[] = []
  ): Promise<void> {
    const now = Date.now();
    await this.db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO channels (id, project_id, name, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
        [channelId, principal.projectId, name, now]
      );

      // Add creator as member
      const membersToAdd = Array.from(new Set([principal.endpointId, ...initialMembers]));
      for (const memberId of membersToAdd) {
        await tx.execute(
          `INSERT OR IGNORE INTO channel_members (channel_id, endpoint_id, joined_at)
           VALUES (?, ?, ?)`,
          [channelId, memberId, now]
        );
      }
    });
  }

  /**
   * Add a member to an existing channel
   */
  async addChannelMember(
    principal: AuthPrincipal,
    channelId: string,
    endpointId: string
  ): Promise<void> {
    const channel = await this.db.queryFirst<{ id: string }>(
      `SELECT id FROM channels WHERE id = ? AND project_id = ?`,
      [channelId, principal.projectId]
    );
    if (!channel) {
      throw new SwitchboardError('NOT_FOUND', `Channel '${channelId}' not found`);
    }

    const endpoint = await this.db.queryFirst<{ id: string }>(
      `SELECT id FROM endpoints WHERE id = ? AND project_id = ?`,
      [endpointId, principal.projectId]
    );
    if (!endpoint) {
      throw new SwitchboardError('NOT_FOUND', `Endpoint '${endpointId}' not found`);
    }

    await this.db.execute(
      `INSERT OR IGNORE INTO channel_members (channel_id, endpoint_id, joined_at)
       VALUES (?, ?, ?)`,
      [channelId, endpointId, Date.now()]
    );
  }

  /**
   * Bounded view of dead-lettered deliveries
   */
  async getDeadLetters(
    principal: AuthPrincipal,
    options?: { limit?: number; offset?: number }
  ): Promise<{ deadLetters: MessageEnvelope[]; total: number }> {
    const limit = Math.min(options?.limit ?? MAX_BATCH_MESSAGES, MAX_BATCH_MESSAGES);
    const offset = options?.offset ?? 0;

    let totalSql = `SELECT COUNT(*) as cnt FROM message_deliveries WHERE project_id = ? AND status = 'DEAD_LETTER'`;
    let querySql = `
      SELECT
        m.id, m.sender_id, m.project_id, m.recipient_type, m.recipient_id,
        m.kind, m.subject, m.payload, m.priority, m.thread_id, m.reply_to_id,
        m.evidence_refs, m.created_at,
        d.sequence, d.status, d.acknowledged_at, d.dead_letter_reason, d.dead_letter_at
      FROM message_deliveries d
      JOIN messages m ON d.project_id = m.project_id AND d.sender_id = m.sender_id AND d.message_id = m.id
      WHERE d.project_id = ? AND d.status = 'DEAD_LETTER'
    `;
    const params: unknown[] = [principal.projectId];
    if (principal.role !== 'admin') {
      totalSql += ` AND (recipient_id = ? OR sender_id = ?)`;
      querySql += ` AND (d.recipient_id = ? OR d.sender_id = ?)`;
      params.push(principal.endpointId, principal.endpointId);
    }

    const totalRow = await this.db.queryFirst<{ cnt: number }>(totalSql, params);

    querySql += ` ORDER BY d.sequence DESC LIMIT ? OFFSET ?`;
    const queryParams = [...params, limit, offset];
    const rows = await this.db.query<any>(querySql, queryParams);

    const deadLetters: MessageEnvelope[] = rows.map((r) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(r.payload);
      } catch {
        payload = r.payload;
      }
      return {
        id: r.id,
        senderId: r.sender_id,
        projectId: r.project_id,
        recipientType: r.recipient_type,
        recipientId: r.recipient_id,
        kind: r.kind,
        subject: r.subject,
        payload,
        priority: r.priority,
        threadId: r.thread_id,
        replyToId: r.reply_to_id,
        evidenceRefs: r.evidence_refs ? JSON.parse(r.evidence_refs) : null,
        serverCreatedAt: r.created_at,
        deliverySequence: r.sequence,
        deliveryStatus: r.status,
        acknowledgedAt: r.acknowledged_at,
        deadLetterReason: r.dead_letter_reason,
        deadLetterAt: r.dead_letter_at,
      };
    });

    return {
      deadLetters,
      total: totalRow?.cnt ?? 0,
    };
  }

  /**
   * Requeue a dead-lettered delivery for redelivery
   */
  async requeueDeadLetter(
    principal: AuthPrincipal,
    deliveryId: number | string
  ): Promise<{ success: boolean; deliveryId: number; status: 'STORED' }> {
    const delivery = await this.db.queryFirst<{
      id: number;
      project_id: string;
      sender_id: string;
      recipient_id: string;
      status: string;
    }>(
      `SELECT id, project_id, sender_id, recipient_id, status FROM message_deliveries WHERE id = ? AND project_id = ?`,
      [deliveryId, principal.projectId]
    );

    if (!delivery) {
      throw new SwitchboardError('NOT_FOUND', `Delivery '${deliveryId}' not found`);
    }

    if (delivery.status !== 'DEAD_LETTER') {
      throw new SwitchboardError(
        'INVALID_INPUT',
        `Delivery '${deliveryId}' is in status '${delivery.status}', cannot requeue unless DEAD_LETTER`
      );
    }

    if (
      principal.role !== 'admin' &&
      principal.endpointId !== delivery.sender_id &&
      principal.endpointId !== delivery.recipient_id
    ) {
      throw new SwitchboardError('FORBIDDEN', 'Permission denied to requeue this delivery');
    }

    const now = Date.now();
    await this.db.execute(
      `UPDATE message_deliveries
       SET status = 'STORED', dead_letter_reason = NULL, dead_letter_at = NULL, delivered_at = ?
       WHERE id = ? AND project_id = ?`,
      [now, deliveryId, principal.projectId]
    );

    return {
      success: true,
      deliveryId: Number(deliveryId),
      status: 'STORED',
    };
  }

  /**
   * Retire an endpoint and clean up its active resources
   */
  async retireEndpoint(
    principal: AuthPrincipal,
    targetEndpointId: string,
    reason?: string
  ): Promise<{ endpointId: string; status: 'retired' }> {
    if (principal.role !== 'admin' && principal.endpointId !== targetEndpointId) {
      throw new SwitchboardError('FORBIDDEN', 'Admin privileges required to retire endpoints');
    }

    const endpoint = await this.db.queryFirst<{ id: string; project_id: string }>(
      `SELECT id, project_id FROM endpoints WHERE id = ? AND project_id = ?`,
      [targetEndpointId, principal.projectId]
    );
    if (!endpoint) {
      throw new SwitchboardError('NOT_FOUND', `Endpoint '${targetEndpointId}' not found`);
    }

    const now = Date.now();
    const retireReason = reason ?? 'Endpoint retired';

    await this.db.transaction(async (tx) => {
      // 1. Update endpoint status
      await tx.execute(
        `UPDATE endpoint_status
         SET state = 'retired', description = ?, updated_at = ?, updated_by = ?
         WHERE endpoint_id = ? AND project_id = ?`,
        [retireReason, now, principal.endpointId, targetEndpointId, principal.projectId]
      );

      // 2. Revoke all credentials for the endpoint
      await tx.execute(
        `UPDATE credentials SET revoked = 1 WHERE endpoint_id = ? AND project_id = ?`,
        [targetEndpointId, principal.projectId]
      );

      // 3. Remove channel memberships
      await tx.execute(
        `DELETE FROM channel_members WHERE endpoint_id = ?`,
        [targetEndpointId]
      );

      // 4. Dead-letter pending deliveries
      await tx.execute(
        `UPDATE message_deliveries
         SET status = 'DEAD_LETTER', dead_letter_reason = ?, dead_letter_at = ?
         WHERE recipient_id = ? AND project_id = ? AND status = 'STORED'`,
        [retireReason, now, targetEndpointId, principal.projectId]
      );
    });

    return {
      endpointId: targetEndpointId,
      status: 'retired',
    };
  }

  /**
   * Create a scheduled or manual backup with full integrity manifest
   */
  async createScheduledBackup(projectId: string): Promise<BackupRecord> {
    const exportData = await this.exportData({
      endpointId: 'system',
      projectId,
      scopes: ['admin'],
      role: 'admin',
    });

    const backupId = `bk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const manifestJson = JSON.stringify(exportData);

    await this.db.execute(
      `INSERT INTO backups (id, project_id, version, checksum_sha256, manifest_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [backupId, projectId, exportData.version, exportData.checksumSha256, manifestJson, now]
    );

    return {
      id: backupId,
      projectId,
      version: exportData.version,
      checksumSha256: exportData.checksumSha256,
      manifestJson,
      createdAt: now,
    };
  }

  /**
   * List recorded backups for project
   */
  async listBackups(principal: AuthPrincipal): Promise<BackupRecord[]> {
    const rows = await this.db.query<{
      id: string;
      project_id: string;
      version: string;
      checksum_sha256: string;
      created_at: number;
    }>(
      `SELECT id, project_id, version, checksum_sha256, created_at
       FROM backups WHERE project_id = ? ORDER BY created_at DESC`,
      [principal.projectId]
    );

    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      version: r.version,
      checksumSha256: r.checksum_sha256,
      createdAt: r.created_at,
    }));
  }

  /**
   * Restore database state from a backup
   */
  async restoreFromBackup(
    principal: AuthPrincipal,
    backupId: string
  ): Promise<{ importedCount: number; backupId: string }> {
    if (principal.role !== 'admin') {
      throw new SwitchboardError('FORBIDDEN', 'Admin privileges required to restore from backup');
    }

    const row = await this.db.queryFirst<{ manifest_json: string }>(
      `SELECT manifest_json FROM backups WHERE id = ? AND project_id = ?`,
      [backupId, principal.projectId]
    );

    if (!row) {
      throw new SwitchboardError('NOT_FOUND', `Backup '${backupId}' not found`);
    }

    const parsed: ExportData = JSON.parse(row.manifest_json);
    const result = await this.importData(principal, parsed);

    return {
      importedCount: result.importedCount,
      backupId,
    };
  }
}
