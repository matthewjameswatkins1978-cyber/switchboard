import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { D1Adapter, type D1DatabaseLike, type D1PreparedStatement } from '../../src/db/d1-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService, sha256 } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { runHousekeeping } from '../../src/operations/housekeeping.js';
import { BudgetManager } from '../../src/operations/budget.js';
import { FileBackupStorage } from '../../src/operations/backup-storage.js';
import type { AuthPrincipal } from '../../src/core/types.js';
import { SwitchboardError } from '../../src/core/errors.js';
import { execSync } from 'node:child_process';
import { unstable_dev } from 'wrangler';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

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
  let testBackupDir: string;
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
    testBackupDir = path.join(process.cwd(), '.test-backups-swb004-' + Date.now());
    const backupStorage = new FileBackupStorage(testBackupDir);
    service = new SwitchboardService(db, undefined, backupStorage);

    await authService.createProject(projectId, 'Ops Test Project');
    await authService.registerEndpoint(projectId, alicePrincipal.endpointId, 'Alice', 'agent');
    await authService.registerEndpoint(projectId, bobPrincipal.endpointId, 'Bob', 'agent');
    await authService.registerEndpoint(projectId, adminPrincipal.endpointId, 'Admin', 'admin');

    await authService.issueToken(projectId, alicePrincipal.endpointId, 'token-alice');
    await authService.issueToken(projectId, bobPrincipal.endpointId, 'token-bob');
    await authService.issueToken(projectId, adminPrincipal.endpointId, 'token-admin', ['admin']);
  });

  afterEach(async () => {
    try {
      await fs.rm(testBackupDir, { recursive: true, force: true });
    } catch {}
  });

  it('processes more than 500 stale deliveries over successive local D1 runs', async () => {
    const runtime = new Miniflare(convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("fixture"); } };',
      compatibilityDate: '2024-11-01',
      d1Databases: ['DB'],
    }));
    try {
      const binding = await runtime.getD1Database('DB');
      const migration = await fs.readFile('src/db/migrations/0001_initial_schema.sql', 'utf8');
      await binding.batch(migration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => binding.prepare(sql)));
      const database = new D1Adapter(binding);
      const auth = new AuthService(database);
      await auth.createProject(projectId, 'Housekeeping fixture');
      await auth.registerEndpoint(projectId, 'sender', 'Sender', 'agent');
      await auth.registerEndpoint(projectId, 'receiver', 'Receiver', 'agent');
      const old = Date.now() - 40 * 86_400_000;
      await database.execute(
        `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 501)
         INSERT INTO messages
           (id, sender_id, project_id, recipient_type, recipient_id, kind, subject, payload, payload_hash, envelope_hash, priority, created_at)
         SELECT 'fixture-' || n, 'sender', ?, 'endpoint', 'receiver', 'fixture.v1', 'Fixture', '{}', 'fixture', 'fixture', 'normal', ?
         FROM sequence`,
        [projectId, old]
      );
      await database.execute(
        `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 501)
         INSERT INTO message_deliveries
           (project_id, message_id, sender_id, recipient_id, sequence, status, delivered_at)
         SELECT ?, 'fixture-' || n, 'sender', 'receiver', n, 'STORED', ? FROM sequence`,
        [projectId, old]
      );
      const count = (status: string) => database.queryFirst<{ total: number }>(
        'SELECT COUNT(*) AS total FROM message_deliveries WHERE status = ?', [status]
      );
      await runHousekeeping(database, { projectId, maxItemsPerRun: 100 });
      expect(await count('DEAD_LETTER')).toEqual({ total: 100 });
      await runHousekeeping(database, { projectId, maxItemsPerRun: 500 });
      await runHousekeeping(database, { projectId, maxItemsPerRun: 500 });
      expect(await count('DEAD_LETTER')).toEqual({ total: 501 });
      expect(await count('STORED')).toEqual({ total: 0 });
      expect(await database.queryFirst('SELECT COUNT(*) AS total FROM messages')).toEqual({ total: 501 });
      await database.execute("UPDATE message_deliveries SET status = 'ACKNOWLEDGED', acknowledged_at = ?", [old]);
      await runHousekeeping(database, { projectId, maxItemsPerRun: 500 });
      expect(await count('ACKNOWLEDGED')).toEqual({ total: 1 });
      await runHousekeeping(database, { projectId, maxItemsPerRun: 500 });
      await runHousekeeping(database, { projectId, maxItemsPerRun: 500 });
      expect(await database.queryFirst('SELECT COUNT(*) AS total FROM archived_deliveries')).toEqual({ total: 501 });
      expect(await database.queryFirst('SELECT COUNT(*) AS total FROM archived_messages')).toEqual({ total: 501 });
      expect(await count('ACKNOWLEDGED')).toEqual({ total: 0 });
    } finally {
      await runtime.dispose();
    }
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
  it('validates schema and qualifies multi-client messaging through wrangler local Worker and D1 runtime', async () => {
    // 1. Ensure schema is self-contained and applied non-interactively
    execSync(
      `npx wrangler d1 execute switchboard-db --local --file=src/db/migrations/0001_initial_schema.sql --yes`,
      { encoding: 'utf8', stdio: 'pipe', timeout: 60000 }
    );

    const cmd = `npx wrangler d1 execute switchboard-db --local --command="SELECT COUNT(*) as tbl_count FROM sqlite_master WHERE type='table' AND name IN ('messages', 'message_deliveries', 'endpoint_status', 'archived_messages', 'archived_deliveries', 'backups', 'usage_accounting', 'endpoint_sequences')" --yes`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 60000 });

    expect(output).toContain('executed successfully');
    expect(output).toContain('"tbl_count": 8');

    // 2. Seed test clients into local D1
    const runSuffix = Date.now();
    const projId = `proj-worker-live-${runSuffix}`;
    const epA = `live-a-${runSuffix}`;
    const epB = `live-b-${runSuffix}`;
    const tokA = `tok-live-a-${runSuffix}`;
    const tokB = `tok-live-b-${runSuffix}`;
    const msg1Id = `msg-live-1-${runSuffix}`;
    const msg2Id = `msg-live-2-${runSuffix}`;

    const hashA = await sha256(tokA);
    const hashB = await sha256(tokB);
    const now = Date.now();

    const seedSql = `
      INSERT OR IGNORE INTO projects (id, name, created_at) VALUES ('${projId}', 'Worker Live Project', ${now});
      INSERT OR REPLACE INTO endpoints (id, project_id, name, role, created_at) VALUES ('${epA}', '${projId}', 'Live A', 'agent', ${now});
      INSERT OR REPLACE INTO endpoints (id, project_id, name, role, created_at) VALUES ('${epB}', '${projId}', 'Live B', 'agent', ${now});
      INSERT OR REPLACE INTO credentials (token_hash, endpoint_id, project_id, scopes, revoked, created_at) VALUES ('${hashA}', '${epA}', '${projId}', '["read","write"]', 0, ${now});
      INSERT OR REPLACE INTO credentials (token_hash, endpoint_id, project_id, scopes, revoked, created_at) VALUES ('${hashB}', '${epB}', '${projId}', '["read","write"]', 0, ${now});
    `;
    execSync(
      `npx wrangler d1 execute switchboard-db --local --command="${seedSql.replace(/\n/g, ' ')}" --yes`,
      { encoding: 'utf8', stdio: 'pipe', timeout: 60000 }
    );

    // 3. Launch actual Worker via unstable_dev against local D1
    const worker = await unstable_dev('src/server/worker.ts', {
      config: 'wrangler.toml',
      experimental: { disableExperimentalWarning: true },
    });

    try {
      // 4. Client A sends message to Client B via Worker HTTP
      const sendRes = await worker.fetch('/api/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokA}`,
        },
        body: JSON.stringify({
          id: msg1Id,
          recipientType: 'endpoint',
          recipientId: epB,
          kind: 'task.v1',
          subject: 'Task dispatch to B',
          payload: { action: 'compute', factor: 42 },
        }),
      });
      expect(sendRes.status).toBe(201);
      const sendJson: any = await sendRes.json();
      expect(sendJson.messageId).toBe(msg1Id);
      expect(sendJson.status).toBe('STORED');

      // 5. Client B fetches inbox via Worker HTTP
      const inboxRes = await worker.fetch('/api/v1/inbox', {
        headers: {
          Authorization: `Bearer ${tokB}`,
        },
      });
      expect(inboxRes.status).toBe(200);
      const inboxJson: any = await inboxRes.json();
      expect(inboxJson.deliveries).toBeDefined();
      const deliv = inboxJson.deliveries.find((d: any) => d.id === msg1Id);
      expect(deliv).toBeDefined();
      expect(deliv.subject).toBe('Task dispatch to B');
      expect(deliv.deliverySequence).toBeGreaterThan(0);

      // 6. Client B acknowledges message via Worker HTTP
      const ackRes = await worker.fetch('/api/v1/acknowledgements', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokB}`,
        },
        body: JSON.stringify([
          { messageId: msg1Id, senderId: epA },
        ]),
      });
      expect(ackRes.status).toBe(200);
      const ackJson: any = await ackRes.json();
      expect(ackJson.receipts).toHaveLength(1);
      expect(ackJson.receipts[0].status).toBe('ACKNOWLEDGED');

      // 7. Client B sends reply back to Client A via Worker HTTP
      const replyRes = await worker.fetch('/api/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokB}`,
        },
        body: JSON.stringify({
          id: msg2Id,
          recipientType: 'endpoint',
          recipientId: epA,
          kind: 'task.reply.v1',
          subject: 'Re: Task dispatch to B',
          payload: { result: 'complete' },
          replyToId: msg1Id,
        }),
      });
      expect(replyRes.status).toBe(201);

      // 8. Client A synchronizes (sync) via Worker HTTP, receiving reply and acknowledging it
      const syncRes = await worker.fetch('/api/v1/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokA}`,
        },
        body: JSON.stringify({
          inboxCursor: 0,
          acknowledgements: [{ messageId: msg2Id, senderId: epB }],
        }),
      });
      expect(syncRes.status).toBe(200);
      const syncJson: any = await syncRes.json();
      expect(syncJson.inboundMessages).toBeDefined();
      const inboundReply = syncJson.inboundMessages.find((m: any) => m.id === msg2Id);
      expect(inboundReply).toBeDefined();
      expect(inboundReply.replyToId).toBe(msg1Id);
      expect(syncJson.acknowledgedReceipts).toBeDefined();
      expect(syncJson.acknowledgedReceipts[0].status).toBe('ACKNOWLEDGED');
    } finally {
      await worker.stop();
    }
  }, 90_000);
});
