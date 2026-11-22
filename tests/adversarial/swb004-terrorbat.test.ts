import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { D1Adapter, type D1DatabaseLike, type D1PreparedStatement } from '../../src/db/d1-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService, sha256 } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { runHousekeeping } from '../../src/operations/housekeeping.js';
import { BudgetManager } from '../../src/operations/budget.js';
import type { AuthPrincipal } from '../../src/core/types.js';
import { SwitchboardError } from '../../src/core/errors.js';
import { execSync } from 'node:child_process';

function createD1Mock(): D1DatabaseLike {
  const memAdapter = new SqliteAdapter(':memory:');
  return {
    prepare(query: string): D1PreparedStatement {
      let bound: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...values: unknown[]) {
          bound = values;
          return stmt;
        },
        async first<T = unknown>(_col?: string): Promise<T | null> {
          return await memAdapter.queryFirst<T>(query, bound);
        },
        async all<T = unknown>(): Promise<{ results?: T[]; success: boolean }> {
          const results = await memAdapter.query<T>(query, bound);
          return { results, success: true };
        },
        async run(): Promise<{ success: boolean; meta?: any }> {
          const res = await memAdapter.execute(query, bound);
          return { success: true, meta: { changes: res.changes, last_row_id: res.lastInsertRowid } };
        },
      };
      return stmt;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      return await memAdapter.transaction(async () => {
        const results: any[] = [];
        for (const s of statements) {
          results.push(await s.run());
        }
        return results;
      });
    },
    async exec(query: string) {
      await memAdapter.exec(query);
      return { count: 1, duration: 1 };
    },
  };
}

describe('SWB-004 Operational Qualification & Terrorbats', () => {
  let db: SqliteAdapter;
  let authService: AuthService;
  let service: SwitchboardService;
  const projectId = 'proj-ops-test';

  const alicePrincipal: AuthPrincipal = {
    endpointId: 'ep-alice',
    projectId,
    scopes: ['read', 'write'],
    role: 'agent',
  };

  const bobPrincipal: AuthPrincipal = {
    endpointId: 'ep-bob',
    projectId,
    scopes: ['read', 'write'],
    role: 'agent',
  };

  const adminPrincipal: AuthPrincipal = {
    endpointId: 'ep-admin',
    projectId,
    scopes: ['read', 'write', 'admin'],
    role: 'admin',
  };

  beforeEach(async () => {
    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    authService = new AuthService(db);
    service = new SwitchboardService(db);

    await authService.createProject(projectId, 'Ops Test Project');
    await authService.registerEndpoint(projectId, alicePrincipal.endpointId, 'Alice', 'agent');
    await authService.registerEndpoint(projectId, bobPrincipal.endpointId, 'Bob', 'agent');
    await authService.registerEndpoint(projectId, adminPrincipal.endpointId, 'Admin', 'admin');

    await authService.issueToken(projectId, alicePrincipal.endpointId, 'token-alice');
    await authService.issueToken(projectId, bobPrincipal.endpointId, 'token-bob');
    await authService.issueToken(projectId, adminPrincipal.endpointId, 'token-admin', ['admin']);
  });

  // 1. D1 Batch Sequencing Collision
  it('D1 batch sequencing correctly buffers and projects sequence numbers across multi-message batch to same recipient', async () => {
    const d1 = createD1Mock();
    const d1Adapter = new D1Adapter(d1);
    await initializeSchema(d1Adapter);

    const d1Auth = new AuthService(d1Adapter);
    const d1Service = new SwitchboardService(d1Adapter);

    await d1Auth.createProject(projectId, 'D1 Project');
    await d1Auth.registerEndpoint(projectId, 'sender', 'Sender', 'agent');
    await d1Auth.registerEndpoint(projectId, 'receiver', 'Receiver', 'agent');

    const senderPrincipal: AuthPrincipal = {
      endpointId: 'sender',
      projectId,
      scopes: ['read', 'write'],
      role: 'agent',
    };

    // Send 3 messages in a single sync batch targeting the same recipient
    const syncRes = await d1Service.sync(senderPrincipal, {
      outgoingMessages: [
        {
          id: 'msg-batch-1',
          recipientType: 'endpoint',
          recipientId: 'receiver',
          kind: 'test.v1',
          subject: 'Batch msg 1',
          payload: { n: 1 },
        },
        {
          id: 'msg-batch-2',
          recipientType: 'endpoint',
          recipientId: 'receiver',
          kind: 'test.v1',
          subject: 'Batch msg 2',
          payload: { n: 2 },
        },
        {
          id: 'msg-batch-3',
          recipientType: 'endpoint',
          recipientId: 'receiver',
          kind: 'test.v1',
          subject: 'Batch msg 3',
          payload: { n: 3 },
        },
      ],
    });

    expect(syncRes.errors).toHaveLength(0);
    expect(syncRes.storedReceipts).toHaveLength(3);

    // Verify recipient deliveries in D1 have sequential sequence numbers (1, 2, 3)
    const receiverPrincipal: AuthPrincipal = {
      endpointId: 'receiver',
      projectId,
      scopes: ['read', 'write'],
      role: 'agent',
    };

    const inbox = await d1Service.getInbox(receiverPrincipal);
    expect(inbox.deliveries).toHaveLength(3);
    expect(inbox.deliveries[0]!.deliverySequence).toBe(1);
    expect(inbox.deliveries[1]!.deliverySequence).toBe(2);
    expect(inbox.deliveries[2]!.deliverySequence).toBe(3);
  });

  // 2. D1 Uncommitted Transactional Visibility
  it('D1 transaction session provides read-your-writes visibility for uncommitted operations', async () => {
    const d1 = createD1Mock();
    const d1Adapter = new D1Adapter(d1);
    await initializeSchema(d1Adapter);

    await d1Adapter.execute(`INSERT INTO projects (id, name, created_at) VALUES ('proj-1', 'Project 1', 1000)`);
    await d1Adapter.execute(`INSERT INTO endpoints (id, project_id, name, created_at) VALUES ('sender-1', 'proj-1', 'Sender', 1000)`);
    await d1Adapter.execute(`INSERT INTO endpoints (id, project_id, name, created_at) VALUES ('receiver-1', 'proj-1', 'Receiver', 1000)`);

    await d1Adapter.transaction(async (tx) => {
      // Insert message within transaction
      await tx.execute(
        `INSERT INTO messages (id, sender_id, project_id, recipient_type, recipient_id, kind, subject, payload, payload_hash, envelope_hash, priority, thread_id, reply_to_id, evidence_refs, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'uncommitted-msg-1',
          'sender-1',
          'proj-1',
          'endpoint',
          'receiver-1',
          'test.v1',
          'Subject',
          '{}',
          'hash1',
          'env1',
          'normal',
          null,
          null,
          null,
          1000,
        ]
      );

      // Query uncommitted message within the same transaction session
      const readBack = await tx.queryFirst<{ id: string; payload_hash: string }>(
        `SELECT id, payload_hash, envelope_hash FROM messages WHERE project_id = ? AND sender_id = ? AND id = ?`,
        ['proj-1', 'sender-1', 'uncommitted-msg-1']
      );

      expect(readBack).toBeDefined();
      expect(readBack?.id).toBe('uncommitted-msg-1');
      expect(readBack?.payload_hash).toBe('hash1');
    });

    // Verify committed state in D1 after transaction completes
    const committed = await d1Adapter.queryFirst<{ id: string }>(
      `SELECT id FROM messages WHERE id = ?`,
      ['uncommitted-msg-1']
    );
    expect(committed?.id).toBe('uncommitted-msg-1');
  });

  // 3. Automatic Housekeeping & Archival Invariant
  it('housekeeping archives acknowledged deliveries and resolved messages while strictly preserving unacknowledged deliveries', async () => {
    const now = Date.now();
    const fortyDaysAgo = now - 40 * 86_400_000;
    const twentyDaysAgo = now - 20 * 86_400_000;
    const fiveDaysAgo = now - 5 * 86_400_000;

    // A. Old acknowledged delivery (40 days old) -> should be archived
    await db.execute(
      `INSERT INTO messages (id, sender_id, project_id, recipient_type, recipient_id, kind, subject, payload, payload_hash, envelope_hash, priority, created_at)
       VALUES ('msg-old-ack', 'ep-alice', ?, 'endpoint', 'ep-bob', 'test.v1', 'Old Acked', '{}', 'hash1', 'env1', 'normal', ?)`,
      [projectId, fortyDaysAgo]
    );
    await db.execute(
      `INSERT INTO message_deliveries (project_id, message_id, sender_id, recipient_id, sequence, status, delivered_at, acknowledged_at)
       VALUES (?, 'msg-old-ack', 'ep-alice', 'ep-bob', 1, 'ACKNOWLEDGED', ?, ?)`,
      [projectId, fortyDaysAgo, fortyDaysAgo]
    );

    // B. Recent acknowledged delivery (5 days old) -> should remain in active deliveries
    await db.execute(
      `INSERT INTO messages (id, sender_id, project_id, recipient_type, recipient_id, kind, subject, payload, payload_hash, envelope_hash, priority, created_at)
       VALUES ('msg-new-ack', 'ep-alice', ?, 'endpoint', 'ep-bob', 'test.v1', 'New Acked', '{}', 'hash2', 'env2', 'normal', ?)`,
      [projectId, fiveDaysAgo]
    );
    await db.execute(
      `INSERT INTO message_deliveries (project_id, message_id, sender_id, recipient_id, sequence, status, delivered_at, acknowledged_at)
       VALUES (?, 'msg-new-ack', 'ep-alice', 'ep-bob', 2, 'ACKNOWLEDGED', ?, ?)`,
      [projectId, fiveDaysAgo, fiveDaysAgo]
    );

    // C. Stale unacknowledged delivery (20 days old > 14 day threshold) -> should become DEAD_LETTER, NOT deleted
    await db.execute(
      `INSERT INTO messages (id, sender_id, project_id, recipient_type, recipient_id, kind, subject, payload, payload_hash, envelope_hash, priority, created_at)
       VALUES ('msg-stale-unack', 'ep-alice', ?, 'endpoint', 'ep-bob', 'test.v1', 'Stale Unack', '{}', 'hash3', 'env3', 'normal', ?)`,
      [projectId, twentyDaysAgo]
    );
    await db.execute(
      `INSERT INTO message_deliveries (project_id, message_id, sender_id, recipient_id, sequence, status, delivered_at)
       VALUES (?, 'msg-stale-unack', 'ep-alice', 'ep-bob', 3, 'STORED', ?)`,
      [projectId, twentyDaysAgo]
    );

    // D. Fresh unacknowledged delivery (5 days old) -> should remain STORED
    await db.execute(
      `INSERT INTO messages (id, sender_id, project_id, recipient_type, recipient_id, kind, subject, payload, payload_hash, envelope_hash, priority, created_at)
       VALUES ('msg-fresh-unack', 'ep-alice', ?, 'endpoint', 'ep-bob', 'test.v1', 'Fresh Unack', '{}', 'hash4', 'env4', 'normal', ?)`,
      [projectId, fiveDaysAgo]
    );
    await db.execute(
      `INSERT INTO message_deliveries (project_id, message_id, sender_id, recipient_id, sequence, status, delivered_at)
       VALUES (?, 'msg-fresh-unack', 'ep-alice', 'ep-bob', 4, 'STORED', ?)`,
      [projectId, fiveDaysAgo]
    );

    // Old audit log (100 days old) -> should be purged
    const hundredDaysAgo = now - 100 * 86_400_000;
    await db.execute(
      `INSERT INTO audit_log (project_id, actor_id, action, created_at)
       VALUES (?, 'ep-admin', 'test_action', ?)`,
      [projectId, hundredDaysAgo]
    );

    // Run housekeeping with defaults (retention: 30d, deadLetterAge: 14d, auditLog: 90d)
    const report = await runHousekeeping(db, { projectId });

    expect(report.archivedDeliveries).toBe(1);
    expect(report.archivedMessages).toBe(1);
    expect(report.deadLetteredDeliveries).toBe(1);
    expect(report.purgedAuditLogs).toBe(1);

    // INVARIANT CHECK: Unacknowledged deliveries must never be deleted!
    const activeDeliveries = await db.query<{ message_id: string; status: string }>(
      `SELECT message_id, status FROM message_deliveries WHERE project_id = ? ORDER BY sequence`,
      [projectId]
    );

    expect(activeDeliveries.find((d) => d.message_id === 'msg-old-ack')).toBeUndefined();
    expect(activeDeliveries.find((d) => d.message_id === 'msg-new-ack')?.status).toBe('ACKNOWLEDGED');
    expect(activeDeliveries.find((d) => d.message_id === 'msg-stale-unack')?.status).toBe('DEAD_LETTER');
    expect(activeDeliveries.find((d) => d.message_id === 'msg-fresh-unack')?.status).toBe('STORED');

    // Verify archived tables
    const archivedDel = await db.queryFirst<{ id: number }>(
      `SELECT id FROM archived_deliveries WHERE message_id = 'msg-old-ack'`
    );
    expect(archivedDel).toBeDefined();

    const archivedMsg = await db.queryFirst<{ id: string }>(
      `SELECT id FROM archived_messages WHERE id = 'msg-old-ack'`
    );
    expect(archivedMsg).toBeDefined();
  });

  // 4. Dead-letter Management & Requeue
  it('retrieves dead letters and allows authorized requeue', async () => {
    // Stale delivery becomes dead-lettered
    const now = Date.now();
    await db.execute(
      `INSERT INTO messages (id, sender_id, project_id, recipient_type, recipient_id, kind, subject, payload, payload_hash, envelope_hash, priority, created_at)
       VALUES ('msg-dl-1', 'ep-alice', ?, 'endpoint', 'ep-bob', 'task.v1', 'Task to Requeue', '{"foo": "bar"}', 'h1', 'e1', 'normal', ?)`,
      [projectId, now - 20 * 86_400_000]
    );
    await db.execute(
      `INSERT INTO message_deliveries (project_id, message_id, sender_id, recipient_id, sequence, status, delivered_at, dead_letter_reason, dead_letter_at)
       VALUES (?, 'msg-dl-1', 'ep-alice', 'ep-bob', 1, 'DEAD_LETTER', ?, 'Expired unacknowledged', ?)`,
      [projectId, now - 20 * 86_400_000, now]
    );

    const dlRow = await db.queryFirst<{ id: number }>(
      `SELECT id FROM message_deliveries WHERE message_id = 'msg-dl-1'`
    );
    const deliveryId = dlRow!.id;

    // Bob views dead letters
    const bobDl = await service.getDeadLetters(bobPrincipal);
    expect(bobDl.total).toBe(1);
    expect(bobDl.deadLetters[0]!.id).toBe('msg-dl-1');
    expect(bobDl.deadLetters[0]!.deadLetterReason).toBe('Expired unacknowledged');

    // Bob requeues the dead letter
    const requeueRes = await service.requeueDeadLetter(bobPrincipal, deliveryId);
    expect(requeueRes.success).toBe(true);
    expect(requeueRes.status).toBe('STORED');

    // Verify status is back to STORED with cleared reason
    const requeuedDelivery = await db.queryFirst<{ status: string; dead_letter_reason: string | null }>(
      `SELECT status, dead_letter_reason FROM message_deliveries WHERE id = ?`,
      [deliveryId]
    );
    expect(requeuedDelivery?.status).toBe('STORED');
    expect(requeuedDelivery?.dead_letter_reason).toBeNull();
  });

  // 5. Endpoint Retirement
  it('retires endpoint, revokes tokens, leaves channels, and dead-letters pending deliveries', async () => {
    // Add Bob to a channel
    await service.createChannel(adminPrincipal, 'chan-dev', 'Development', [bobPrincipal.endpointId]);
    // Send message to Bob
    await service.sendMessage(alicePrincipal, {
      id: 'msg-to-retiree',
      recipientType: 'endpoint',
      recipientId: bobPrincipal.endpointId,
      kind: 'notice.v1',
      subject: 'Before retirement',
      payload: { hello: 'world' },
    });

    // Retire Bob
    const retireResult = await service.retireEndpoint(adminPrincipal, bobPrincipal.endpointId, 'Deprovisioned agent');
    expect(retireResult.status).toBe('retired');

    // Verify endpoint state is 'retired'
    const status = await service.getStatus(alicePrincipal, bobPrincipal.endpointId);
    expect(status.state).toBe('retired');
    expect(status.description).toBe('Deprovisioned agent');

    // Verify Bob's tokens are revoked
    await expect(authService.authenticate('token-bob')).rejects.toThrow(SwitchboardError);

    // Verify Bob is removed from channel
    const member = await db.queryFirst<{ endpoint_id: string }>(
      `SELECT endpoint_id FROM channel_members WHERE channel_id = 'chan-dev' AND endpoint_id = ?`,
      [bobPrincipal.endpointId]
    );
    expect(member).toBeNull();

    // Verify Bob's pending deliveries are marked DEAD_LETTER
    const dl = await db.queryFirst<{ status: string; dead_letter_reason: string }>(
      `SELECT status, dead_letter_reason FROM message_deliveries WHERE recipient_id = ? AND message_id = 'msg-to-retiree'`,
      [bobPrincipal.endpointId]
    );
    expect(dl?.status).toBe('DEAD_LETTER');
    expect(dl?.dead_letter_reason).toBe('Deprovisioned agent');
  });

  // 6. Scheduled, Recoverable Backups
  it('creates scheduled backup with SHA-256 checksum and restores cleanly on disaster recovery', async () => {
    // Send a message to have meaningful data
    await service.sendMessage(alicePrincipal, {
      id: 'msg-backup-test',
      recipientType: 'endpoint',
      recipientId: bobPrincipal.endpointId,
      kind: 'data.v1',
      subject: 'Backup Content',
      payload: { vital: 42 },
    });

    // Create backup
    const backup = await service.createScheduledBackup(projectId);
    expect(backup.id).toMatch(/^bk_/);
    expect(backup.checksumSha256).toBeDefined();

    // Verify listBackups
    const backupsList = await service.listBackups(adminPrincipal);
    expect(backupsList).toHaveLength(1);
    expect(backupsList[0]!.id).toBe(backup.id);

    // Simulate database corruption / disaster: delete messages & deliveries
    await db.execute(`DELETE FROM message_deliveries WHERE project_id = ?`, [projectId]);
    await db.execute(`DELETE FROM messages WHERE project_id = ?`, [projectId]);

    const emptyDeliveries = await db.query(`SELECT id FROM message_deliveries WHERE project_id = ?`, [projectId]);
    expect(emptyDeliveries).toHaveLength(0);

    // Disaster recovery: restore from backup
    const restoreRes = await service.restoreFromBackup(adminPrincipal, backup.id);
    expect(restoreRes.importedCount).toBeGreaterThan(0);

    // Verify message and delivery recovered
    const recovered = await db.queryFirst<{ id: string; subject: string }>(
      `SELECT id, subject FROM messages WHERE id = 'msg-backup-test' AND project_id = ?`,
      [projectId]
    );
    expect(recovered).toBeDefined();
    expect(recovered?.subject).toBe('Backup Content');
  });

  // 7. Credential Rotation with Grace Period
  it('supports zero-downtime credential rotation with optional grace period', async () => {
    const originalToken = 'token-original';
    const rotatedToken = 'token-rotated';
    await authService.issueToken(projectId, alicePrincipal.endpointId, originalToken);

    // Authenticate with original
    const auth1 = await authService.authenticate(originalToken);
    expect(auth1.endpointId).toBe(alicePrincipal.endpointId);

    // Rotate with 10-second grace period
    const rotateRes = await authService.rotateToken(projectId, alicePrincipal.endpointId, rotatedToken, {
      oldToken: originalToken,
      gracePeriodMs: 10_000,
    });
    expect(rotateRes.status).toBe('rotated');
    expect(rotateRes.gracePeriodMs).toBe(10_000);

    // Both new and old tokens are valid during grace period
    const authNew = await authService.authenticate(rotatedToken);
    expect(authNew.endpointId).toBe(alicePrincipal.endpointId);

    const authOldDuringGrace = await authService.authenticate(originalToken);
    expect(authOldDuringGrace.endpointId).toBe(alicePrincipal.endpointId);

    // Immediate rotation (gracePeriodMs = 0) revokes old token immediately
    const finalToken = 'token-final';
    await authService.rotateToken(projectId, alicePrincipal.endpointId, finalToken, {
      oldToken: rotatedToken,
      gracePeriodMs: 0,
    });

    // Final token works
    const authFinal = await authService.authenticate(finalToken);
    expect(authFinal.endpointId).toBe(alicePrincipal.endpointId);

    // Rotated token is immediately rejected
    await expect(authService.authenticate(rotatedToken)).rejects.toThrow(SwitchboardError);
  });

  // 8. Usage Budgets & Economic Self-Regulation
  it('adjusts polling cadence multipliers at budget thresholds and throttles non-urgent operations at 100%', async () => {
    const budget = BudgetManager.getInstance();

    // Set custom tight limits for test
    await budget.setLimits(db, projectId, {
      maxRequests: 100,
      maxRowsWritten: 100,
    });

    // 0% -> HEALTHY, multiplier 1.0
    let report = await budget.getReport(db, projectId);
    expect(report.status).toBe('HEALTHY');
    expect(report.cadenceMultiplier).toBe(1.0);

    // 55% -> WARNING_50, multiplier 1.2
    await budget.recordUsage(db, projectId, { requests: 55 });
    report = await budget.getReport(db, projectId);
    expect(report.status).toBe('WARNING_50');
    expect(report.cadenceMultiplier).toBe(1.2);

    // 78% -> WARNING_75, multiplier 1.5
    await budget.recordUsage(db, projectId, { requests: 23 });
    report = await budget.getReport(db, projectId);
    expect(report.status).toBe('WARNING_75');
    expect(report.cadenceMultiplier).toBe(1.5);

    // 92% -> THROTTLE_90, multiplier 2.0
    await budget.recordUsage(db, projectId, { requests: 14 });
    report = await budget.getReport(db, projectId);
    expect(report.status).toBe('THROTTLE_90');
    expect(report.cadenceMultiplier).toBe(2.0);

    // Sync under 92% budget returns spaced cadence (e.g. 5000ms * 2.0 = 10000ms)
    const syncRes = await service.sync(alicePrincipal, {});
    expect(syncRes.recommendedNextSyncMs).toBeGreaterThanOrEqual(10000);

    // 100% -> EXCEEDED_100, non-urgent throttled, urgent permitted
    await budget.recordUsage(db, projectId, { requests: 8 });
    report = await budget.getReport(db, projectId);
    expect(report.status).toBe('EXCEEDED_100');
    expect(report.cadenceMultiplier).toBe(3.0);

    // Non-urgent message is throttled
    await expect(
      service.sendMessage(alicePrincipal, {
        id: 'msg-non-urgent-throttled',
        recipientType: 'endpoint',
        recipientId: bobPrincipal.endpointId,
        kind: 'info.v1',
        subject: 'Normal Priority Message',
        payload: { text: 'throttled' },
        priority: 'normal',
      })
    ).rejects.toThrow(SwitchboardError);

    // Urgent message bypasses throttle
    const urgentReceipt = await service.sendMessage(alicePrincipal, {
      id: 'msg-urgent-allowed',
      recipientType: 'endpoint',
      recipientId: bobPrincipal.endpointId,
      kind: 'alert.v1',
      subject: 'Urgent Priority Message',
      payload: { text: 'allowed' },
      priority: 'urgent',
    });
    expect(urgentReceipt.status).toBe('STORED');
  });

  // 9. Real D1 Runtime Tests via Wrangler Local
  it('validates schema and D1 execution against wrangler local D1 runtime', () => {
    const cmd = `npx wrangler d1 execute switchboard-db --local --command="SELECT COUNT(*) as tbl_count FROM sqlite_master WHERE type='table' AND name IN ('messages', 'message_deliveries', 'endpoint_status', 'archived_messages', 'archived_deliveries', 'backups', 'usage_accounting')"`;
    const output = execSync(cmd, { encoding: 'utf8' });

    expect(output).toContain('executed successfully');
    expect(output).toContain('"tbl_count": 7');
  });
});
