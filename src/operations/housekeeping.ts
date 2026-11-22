import type { DatabaseSession } from '../db/database.js';

export interface HousekeepingOptions {
  projectId?: string;
  retentionDays?: number; // default 30
  deadLetterAgeDays?: number; // default 14
  auditLogRetentionDays?: number; // default 90
}

export interface HousekeepingReport {
  projectId?: string;
  archivedDeliveries: number;
  archivedMessages: number;
  deadLetteredDeliveries: number;
  purgedAuditLogs: number;
  cutoffTimeMs: number;
  executedAt: number;
}

export async function runHousekeeping(
  db: DatabaseSession,
  options: HousekeepingOptions = {}
): Promise<HousekeepingReport> {
  const now = Date.now();
  const retentionDays = options.retentionDays ?? 30;
  const deadLetterDays = options.deadLetterAgeDays ?? 14;
  const auditDays = options.auditLogRetentionDays ?? 90;

  const cutoff = now - retentionDays * 86_400_000;
  const deadLetterCutoff = now - deadLetterDays * 86_400_000;
  const auditCutoff = now - auditDays * 86_400_000;

  return await db.transaction(async (tx) => {
    // 1. Automatic dead-lettering of stale unacknowledged messages
    let deadLetterSql = `
      UPDATE message_deliveries
      SET status = 'DEAD_LETTER',
          dead_letter_reason = 'Delivery expired unacknowledged past dead-letter threshold',
          dead_letter_at = ?
      WHERE status = 'STORED' AND delivered_at < ?
    `;
    const deadLetterParams: unknown[] = [now, deadLetterCutoff];
    if (options.projectId) {
      deadLetterSql += ` AND project_id = ?`;
      deadLetterParams.push(options.projectId);
    }
    const deadLetterRes = await tx.execute(deadLetterSql, deadLetterParams);

    // 2. Archive acknowledged deliveries older than retention cutoff
    let archiveDelSql = `
      INSERT OR IGNORE INTO archived_deliveries
      (id, project_id, message_id, sender_id, recipient_id, channel_id, sequence,
       status, delivered_at, received_at, acknowledged_at, acknowledgement_note,
       dead_letter_reason, dead_letter_at, archived_at)
      SELECT id, project_id, message_id, sender_id, recipient_id, channel_id, sequence,
             status, delivered_at, received_at, acknowledged_at, acknowledgement_note,
             dead_letter_reason, dead_letter_at, ?
      FROM message_deliveries
      WHERE status = 'ACKNOWLEDGED' AND acknowledged_at IS NOT NULL AND acknowledged_at < ?
    `;
    const archiveDelParams: unknown[] = [now, cutoff];
    if (options.projectId) {
      archiveDelSql += ` AND project_id = ?`;
      archiveDelParams.push(options.projectId);
    }
    const archiveDelRes = await tx.execute(archiveDelSql, archiveDelParams);

    // Remove archived deliveries from active delivery table
    let deleteDelSql = `
      DELETE FROM message_deliveries
      WHERE status = 'ACKNOWLEDGED' AND acknowledged_at IS NOT NULL AND acknowledged_at < ?
    `;
    const deleteDelParams: unknown[] = [cutoff];
    if (options.projectId) {
      deleteDelSql += ` AND project_id = ?`;
      deleteDelParams.push(options.projectId);
    }
    await tx.execute(deleteDelSql, deleteDelParams);

    // 3. Archive messages where all deliveries have been resolved and purged from active deliveries
    let archiveMsgSql = `
      INSERT OR IGNORE INTO archived_messages
      (id, sender_id, project_id, recipient_type, recipient_id, kind, subject,
       payload, payload_hash, envelope_hash, priority, thread_id, reply_to_id,
       evidence_refs, created_at, archived_at)
      SELECT m.id, m.sender_id, m.project_id, m.recipient_type, m.recipient_id, m.kind, m.subject,
             m.payload, m.payload_hash, m.envelope_hash, m.priority, m.thread_id, m.reply_to_id,
             m.evidence_refs, m.created_at, ?
      FROM messages m
      WHERE m.created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM message_deliveries d
          WHERE d.project_id = m.project_id AND d.sender_id = m.sender_id AND d.message_id = m.id
        )
    `;
    const archiveMsgParams: unknown[] = [now, cutoff];
    if (options.projectId) {
      archiveMsgSql += ` AND m.project_id = ?`;
      archiveMsgParams.push(options.projectId);
    }
    const archiveMsgRes = await tx.execute(archiveMsgSql, archiveMsgParams);

    let deleteMsgSql = `
      DELETE FROM messages
      WHERE created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM message_deliveries d
          WHERE d.project_id = messages.project_id AND d.sender_id = messages.sender_id AND d.message_id = messages.id
        )
    `;
    const deleteMsgParams: unknown[] = [cutoff];
    if (options.projectId) {
      deleteMsgSql += ` AND project_id = ?`;
      deleteMsgParams.push(options.projectId);
    }
    await tx.execute(deleteMsgSql, deleteMsgParams);

    // 4. Purge stale audit logs
    let auditSql = `DELETE FROM audit_log WHERE created_at < ?`;
    const auditParams: unknown[] = [auditCutoff];
    if (options.projectId) {
      auditSql += ` AND project_id = ?`;
      auditParams.push(options.projectId);
    }
    const auditRes = await tx.execute(auditSql, auditParams);

    return {
      projectId: options.projectId,
      archivedDeliveries: archiveDelRes.changes,
      archivedMessages: archiveMsgRes.changes,
      deadLetteredDeliveries: deadLetterRes.changes,
      purgedAuditLogs: auditRes.changes,
      cutoffTimeMs: cutoff,
      executedAt: now,
    };
  });
}
