import type { DatabaseSession } from '../db/database.js';

export interface HousekeepingOptions {
  projectId?: string;
  retentionDays?: number; // default 30
  deadLetterAgeDays?: number; // default 14
  auditLogRetentionDays?: number; // default 90
  maxItemsPerRun?: number; // default 500
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
  const maxItems = options.maxItemsPerRun ?? 500;

  const cutoff = now - retentionDays * 86_400_000;
  const deadLetterCutoff = now - deadLetterDays * 86_400_000;
  const auditCutoff = now - auditDays * 86_400_000;

  return await db.transaction(async (tx) => {
    // 1. Automatic dead-lettering of stale unacknowledged messages (bounded)
    let candidateDlSql = `
      SELECT id FROM message_deliveries
      WHERE status = 'STORED' AND delivered_at < ?
    `;
    const candidateDlParams: unknown[] = [deadLetterCutoff];
    if (options.projectId) {
      candidateDlSql += ` AND project_id = ?`;
      candidateDlParams.push(options.projectId);
    }
    candidateDlSql += ` ORDER BY id ASC LIMIT ?`;
    candidateDlParams.push(maxItems);

    const candidateDls = await tx.query<{ id: number }>(candidateDlSql, candidateDlParams);
    let deadLetteredCount = 0;
    if (candidateDls.length > 0) {
      const ids = candidateDls.map((d) => d.id);
      const placeholders = ids.map(() => '?').join(',');
      const res = await tx.execute(
        `UPDATE message_deliveries
         SET status = 'DEAD_LETTER',
             dead_letter_reason = 'Delivery expired unacknowledged past dead-letter threshold',
             dead_letter_at = ?
         WHERE id IN (${placeholders})`,
        [now, ...ids]
      );
      deadLetteredCount = res.changes;
    }

    // 2. Archive acknowledged deliveries older than retention cutoff (bounded)
    let candidateDelSql = `
      SELECT id FROM message_deliveries
      WHERE status = 'ACKNOWLEDGED' AND acknowledged_at IS NOT NULL AND acknowledged_at < ?
    `;
    const candidateDelParams: unknown[] = [cutoff];
    if (options.projectId) {
      candidateDelSql += ` AND project_id = ?`;
      candidateDelParams.push(options.projectId);
    }
    candidateDelSql += ` ORDER BY id ASC LIMIT ?`;
    candidateDelParams.push(maxItems);

    const candidateDels = await tx.query<{ id: number }>(candidateDelSql, candidateDelParams);
    let archivedDelCount = 0;
    if (candidateDels.length > 0) {
      const ids = candidateDels.map((d) => d.id);
      const placeholders = ids.map(() => '?').join(',');
      const archiveRes = await tx.execute(
        `INSERT OR IGNORE INTO archived_deliveries
         (id, project_id, message_id, sender_id, recipient_id, channel_id, sequence,
          status, delivered_at, received_at, acknowledged_at, acknowledgement_note,
          dead_letter_reason, dead_letter_at, archived_at)
         SELECT id, project_id, message_id, sender_id, recipient_id, channel_id, sequence,
                status, delivered_at, received_at, acknowledged_at, acknowledgement_note,
                dead_letter_reason, dead_letter_at, ?
         FROM message_deliveries
         WHERE id IN (${placeholders})`,
        [now, ...ids]
      );
      archivedDelCount = archiveRes.changes;

      await tx.execute(
        `DELETE FROM message_deliveries WHERE id IN (${placeholders})`,
        ids
      );
    }

    // 3. Archive messages where all deliveries have been resolved and purged from active deliveries (bounded)
    let candidateMsgSql = `
      SELECT m.id, m.sender_id, m.project_id FROM messages m
      WHERE m.created_at < ?
    `;
    const candidateMsgParams: unknown[] = [cutoff];
    if (options.projectId) {
      candidateMsgSql += ` AND m.project_id = ?`;
      candidateMsgParams.push(options.projectId);
    }
    candidateMsgSql += `
      AND NOT EXISTS (
        SELECT 1 FROM message_deliveries d
        WHERE d.project_id = m.project_id AND d.sender_id = m.sender_id AND d.message_id = m.id
      )
      ORDER BY m.internal_id ASC LIMIT ?
    `;
    candidateMsgParams.push(maxItems);

    const candidateMsgs = await tx.query<{ id: string; sender_id: string; project_id: string }>(
      candidateMsgSql,
      candidateMsgParams
    );
    let archivedMsgCount = 0;
    if (candidateMsgs.length > 0) {
      for (const m of candidateMsgs) {
        await tx.execute(
          `INSERT OR IGNORE INTO archived_messages
           (id, sender_id, project_id, recipient_type, recipient_id, kind, subject,
            payload, payload_hash, envelope_hash, priority, thread_id, reply_to_id,
            evidence_refs, created_at, archived_at)
           SELECT id, sender_id, project_id, recipient_type, recipient_id, kind, subject,
                  payload, payload_hash, envelope_hash, priority, thread_id, reply_to_id,
                  evidence_refs, created_at, ?
           FROM messages
           WHERE project_id = ? AND sender_id = ? AND id = ?`,
          [now, m.project_id, m.sender_id, m.id]
        );
        await tx.execute(
          `DELETE FROM messages WHERE project_id = ? AND sender_id = ? AND id = ?`,
          [m.project_id, m.sender_id, m.id]
        );
        archivedMsgCount++;
      }
    }

    // 4. Purge stale audit logs (bounded)
    let auditSql = `
      DELETE FROM audit_log
      WHERE id IN (
        SELECT id FROM audit_log WHERE created_at < ? ${options.projectId ? 'AND project_id = ?' : ''}
        ORDER BY id ASC LIMIT ?
      )
    `;
    const auditParams: unknown[] = [auditCutoff];
    if (options.projectId) {
      auditParams.push(options.projectId);
    }
    auditParams.push(maxItems);
    const auditRes = await tx.execute(auditSql, auditParams);

    return {
      projectId: options.projectId,
      archivedDeliveries: archivedDelCount,
      archivedMessages: archivedMsgCount,
      deadLetteredDeliveries: deadLetteredCount,
      purgedAuditLogs: auditRes.changes,
      cutoffTimeMs: cutoff,
      executedAt: now,
    };
  });
}
