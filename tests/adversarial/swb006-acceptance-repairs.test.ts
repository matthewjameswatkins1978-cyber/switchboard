import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { D1Adapter, type D1DatabaseLike, type D1PreparedStatement } from '../../src/db/d1-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { runHousekeeping } from '../../src/operations/housekeeping.js';
import { BudgetManager, DEFAULT_BUDGET_LIMITS, CYCLE_DURATION_MS } from '../../src/operations/budget.js';
import { FileBackupStorage } from '../../src/operations/backup-storage.js';
import type { AuthPrincipal } from '../../src/core/types.js';
import { SwitchboardError } from '../../src/core/errors.js';
import fs from 'node:fs/promises';
import path from 'node:path';

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

describe('SWB-006 Final Acceptance Repairs Qualification', () => {
  let db: SqliteAdapter;
  let authService: AuthService;
  let service: SwitchboardService;
  let testBackupDir: string;
  let backupStorage: FileBackupStorage;
  const projectId = 'proj-swb006-repairs';

  const alice: AuthPrincipal = {
    endpointId: 'ep-alice',
    projectId,
    scopes: ['read', 'write'],
    role: 'agent',
  };

  const bob: AuthPrincipal = {
    endpointId: 'ep-bob',
    projectId,
    scopes: ['read', 'write'],
    role: 'agent',
  };

  const admin: AuthPrincipal = {
    endpointId: 'ep-admin',
    projectId,
    scopes: ['read', 'write', 'admin'],
    role: 'admin',
  };

  beforeEach(async () => {
    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    authService = new AuthService(db);

    testBackupDir = path.join(process.cwd(), '.test-backups-' + Date.now());
    backupStorage = new FileBackupStorage(testBackupDir);
    service = new SwitchboardService(db, undefined, backupStorage);

    await authService.createProject(projectId, 'SWB-006 Repairs Project');
    await authService.registerEndpoint(projectId, alice.endpointId, 'Alice', 'agent');
    await authService.registerEndpoint(projectId, bob.endpointId, 'Bob', 'agent');
    await authService.registerEndpoint(projectId, admin.endpointId, 'Admin', 'admin');

    await authService.issueToken(projectId, alice.endpointId, 'token-alice');
    await authService.issueToken(projectId, bob.endpointId, 'token-bob');
    await authService.issueToken(projectId, admin.endpointId, 'token-admin', ['admin']);
  });

  afterEach(async () => {
    try {
      await fs.rm(testBackupDir, { recursive: true, force: true });
    } catch {}
  });

  // Finding 1: Preserve monotonic delivery sequences across archival
  it('preserves monotonic delivery sequences for recipients after active deliveries are archived', async () => {
    // 1. Alice sends 3 messages to Bob
    await service.sendMessage(alice, {
      id: 'msg-seq-1',
      recipientType: 'endpoint',
      recipientId: bob.endpointId,
      kind: 'msg.v1',
      subject: 'Message 1',
      payload: { n: 1 },
    });
    await service.sendMessage(alice, {
      id: 'msg-seq-2',
      recipientType: 'endpoint',
      recipientId: bob.endpointId,
      kind: 'msg.v1',
      subject: 'Message 2',
      payload: { n: 2 },
    });
    await service.sendMessage(alice, {
      id: 'msg-seq-3',
      recipientType: 'endpoint',
      recipientId: bob.endpointId,
      kind: 'msg.v1',
      subject: 'Message 3',
      payload: { n: 3 },
    });

    // Bob syncs and acknowledges all 3
    const bobInbox = await service.getInbox(bob);
    expect(bobInbox.deliveries).toHaveLength(3);
    expect(bobInbox.deliveries[0]!.deliverySequence).toBe(1);
    expect(bobInbox.deliveries[1]!.deliverySequence).toBe(2);
    expect(bobInbox.deliveries[2]!.deliverySequence).toBe(3);

    await service.acknowledge(
      bob,
      bobInbox.deliveries.map((d) => ({ messageId: d.id, senderId: d.senderId }))
    );

    // 2. Fast-forward time and run housekeeping to archive all 3 deliveries
    const thirtyOneDaysAgo = Date.now() - 31 * 86_400_000;
    await db.execute(`UPDATE message_deliveries SET acknowledged_at = ? WHERE project_id = ?`, [
      thirtyOneDaysAgo,
      projectId,
    ]);
    await db.execute(`UPDATE messages SET created_at = ? WHERE project_id = ?`, [
      thirtyOneDaysAgo,
      projectId,
    ]);

    const houseReport = await runHousekeeping(db, { projectId, retentionDays: 30 });
    expect(houseReport.archivedDeliveries).toBe(3);

    // Verify message_deliveries table now has 0 active deliveries for Bob
    const remainingActive = await db.query(
      `SELECT id FROM message_deliveries WHERE project_id = ? AND recipient_id = ?`,
      [projectId, bob.endpointId]
    );
    expect(remainingActive).toHaveLength(0);

    // 3. Alice sends a 4th message to Bob
    const receipt4 = await service.sendMessage(alice, {
      id: 'msg-seq-4',
      recipientType: 'endpoint',
      recipientId: bob.endpointId,
      kind: 'msg.v1',
      subject: 'Message 4 after archival',
      payload: { n: 4 },
    });
    expect(receipt4.status).toBe('STORED');

    // 4. Verify that message 4 receives sequence 4 (NOT 1!)
    const bobInboxAfter = await service.getInbox(bob);
    expect(bobInboxAfter.deliveries).toHaveLength(1);
    expect(bobInboxAfter.deliveries[0]!.id).toBe('msg-seq-4');
    expect(bobInboxAfter.deliveries[0]!.deliverySequence).toBe(4);
  });

  // Finding 1 (Cont): Preserve monotonic delivery sequences across disaster restoration
  it('preserves monotonic delivery sequences after disaster restoration', async () => {
    // Send 2 messages
    await service.sendMessage(alice, {
      id: 'msg-pre-disaster-1',
      recipientType: 'endpoint',
      recipientId: bob.endpointId,
      kind: 'msg.v1',
      subject: 'Before disaster 1',
      payload: {},
    });
    await service.sendMessage(alice, {
      id: 'msg-pre-disaster-2',
      recipientType: 'endpoint',
      recipientId: bob.endpointId,
      kind: 'msg.v1',
      subject: 'Before disaster 2',
      payload: {},
    });

    // Create backup
    const backup = await service.createScheduledBackup(projectId);

    // Complete disaster: wipe all tables
    await db.execute(`DELETE FROM message_deliveries WHERE project_id = ?`, [projectId]);
    await db.execute(`DELETE FROM messages WHERE project_id = ?`, [projectId]);
    await db.execute(`DELETE FROM endpoint_sequences WHERE project_id = ?`, [projectId]);

    // Restore from backup
    await service.restoreFromBackup(admin, backup.id);

    // Send 3rd message
    await service.sendMessage(alice, {
      id: 'msg-post-disaster-3',
      recipientType: 'endpoint',
      recipientId: bob.endpointId,
      kind: 'msg.v1',
      subject: 'After disaster 3',
      payload: {},
    });

    const bobInbox = await service.getInbox(bob);
    const postDisasterMsg = bobInbox.deliveries.find((d) => d.id === 'msg-post-disaster-3');
    expect(postDisasterMsg).toBeDefined();
    expect(postDisasterMsg!.deliverySequence).toBe(3);
  });

  // Finding 2: Preserve idempotency across complete message lifecycle including archived messages
  it('preserves idempotency and conflict detection across archived messages', async () => {
    const msgId = 'msg-lifecycle-test';
    const payload = { important: 'data' };

    // 1. Alice sends message
    const initialReceipt = await service.sendMessage(alice, {
      id: msgId,
      recipientType: 'endpoint',
      recipientId: bob.endpointId,
      kind: 'test.v1',
      subject: 'Initial Message',
      payload,
    });
    expect(initialReceipt.status).toBe('STORED');

    // Bob acks it
    await service.acknowledge(bob, [{ messageId: msgId, senderId: alice.endpointId }]);

    // Message gets archived
    const pastTime = Date.now() - 35 * 86_400_000;
    await db.execute(`UPDATE message_deliveries SET acknowledged_at = ? WHERE message_id = ?`, [pastTime, msgId]);
    await db.execute(`UPDATE messages SET created_at = ? WHERE id = ?`, [pastTime, msgId]);
    await runHousekeeping(db, { projectId, retentionDays: 30 });

    // Verify it is no longer in active messages table
    const inActive = await db.queryFirst(`SELECT id FROM messages WHERE id = ?`, [msgId]);
    expect(inActive).toBeNull();

    // Verify it IS in archived_messages
    const inArchived = await db.queryFirst(`SELECT id FROM archived_messages WHERE id = ?`, [msgId]);
    expect(inArchived).toBeDefined();

    // 2. Alice resends identical message (identical envelope)
    const duplicateReceipt = await service.sendMessage(alice, {
      id: msgId,
      recipientType: 'endpoint',
      recipientId: bob.endpointId,
      kind: 'test.v1',
      subject: 'Initial Message',
      payload,
    });

    // Idempotent duplicate must be recognized and suppressed
    expect(duplicateReceipt.isDuplicate).toBe(true);
    expect(duplicateReceipt.messageId).toBe(msgId);
    expect(duplicateReceipt.status).toBe('STORED');

    // 3. Alice attempts to reuse msgId with differing payload -> CONFLICT
    await expect(
      service.sendMessage(alice, {
        id: msgId,
        recipientType: 'endpoint',
        recipientId: bob.endpointId,
        kind: 'test.v1',
        subject: 'Differing Subject',
        payload: { changed: true },
      })
    ).rejects.toThrow(SwitchboardError);

    // 4. Bob can reply to the archived message referencing replyToId
    const replyReceipt = await service.sendMessage(bob, {
      id: 'reply-to-archived',
      recipientType: 'endpoint',
      recipientId: alice.endpointId,
      kind: 'reply.v1',
      subject: 'Reply to archived',
      payload: { ack: true },
      replyToId: msgId,
    });
    expect(replyReceipt.status).toBe('STORED');
  });

  // Finding 3: Never reactivate revoked or expired credentials during rotation
  it('never reactivates revoked or expired credentials during credential rotation', async () => {
    const tokenRevoked = 'token-to-revoke';
    const tokenActive = 'token-to-stay-active';

    await authService.issueToken(projectId, alice.endpointId, tokenRevoked);
    await authService.issueToken(projectId, alice.endpointId, tokenActive);

    // Revoke tokenRevoked
    await authService.revokeToken(tokenRevoked);

    // Verify it is rejected
    await expect(authService.authenticate(tokenRevoked)).rejects.toThrow(SwitchboardError);

    // Attempting to specifically rotate an already revoked token must fail
    await expect(
      authService.rotateToken(projectId, alice.endpointId, 'new-token-1', {
        oldToken: tokenRevoked,
        gracePeriodMs: 60_000,
      })
    ).rejects.toThrow(SwitchboardError);

    // Rotating without specifying oldToken rotates active credentials, but MUST NOT reactivate revoked credentials
    const newToken2 = 'new-token-2';
    await authService.rotateToken(projectId, alice.endpointId, newToken2, {
      gracePeriodMs: 60_000,
    });

    // New token works
    const newAuth = await authService.authenticate(newToken2);
    expect(newAuth.endpointId).toBe(alice.endpointId);

    // The previously active token is valid during grace period
    const activeAuth = await authService.authenticate(tokenActive);
    expect(activeAuth.endpointId).toBe(alice.endpointId);

    // INVARIANT CHECK: The revoked token MUST STILL BE REJECTED!
    await expect(authService.authenticate(tokenRevoked)).rejects.toThrow(SwitchboardError);

    // DELTA ITEM 1 REGRESSION: Passing a previously used/revoked token as the NEW replacement token must fail
    await expect(
      authService.rotateToken(projectId, alice.endpointId, tokenRevoked, {
        oldToken: newToken2,
        gracePeriodMs: 60_000,
      })
    ).rejects.toThrow(SwitchboardError);

    // INVARIANT CHECK: The revoked token MUST STILL BE REJECTED upon authenticate!
    await expect(authService.authenticate(tokenRevoked)).rejects.toThrow(SwitchboardError);

    // Passing an existing active token as the NEW replacement token must also fail
    await expect(
      authService.rotateToken(projectId, alice.endpointId, tokenActive, {
        oldToken: newToken2,
      })
    ).rejects.toThrow(SwitchboardError);

    // Cannot reissue or reactivate a revoked token via issueToken
    await expect(
      authService.issueToken(projectId, alice.endpointId, tokenRevoked)
    ).rejects.toThrow(SwitchboardError);

    // Test with expired token
    const tokenExpired = 'token-already-expired';
    await authService.issueToken(projectId, alice.endpointId, tokenExpired, ['read', 'write'], -5000); // expired 5s ago

    // Attempting to rotate an already expired token must fail
    await expect(
      authService.rotateToken(projectId, alice.endpointId, 'new-token-3', {
        oldToken: tokenExpired,
        gracePeriodMs: 60_000,
      })
    ).rejects.toThrow(SwitchboardError);
  });

  // Finding 4: Bounded automatic housekeeping
  it('enforces bounded limits on housekeeping batches to prevent unbounded locks', async () => {
    const pastTime = Date.now() - 40 * 86_400_000;

    // Create 10 old acknowledged deliveries
    for (let i = 1; i <= 10; i++) {
      const mId = `bulk-msg-${i}`;
      await db.execute(
        `INSERT INTO messages (id, sender_id, project_id, recipient_type, recipient_id, kind, subject, payload, payload_hash, envelope_hash, priority, created_at)
         VALUES (?, 'ep-alice', ?, 'endpoint', 'ep-bob', 'bulk.v1', 'Bulk', '{}', 'h', 'e', 'normal', ?)`,
        [mId, projectId, pastTime]
      );
      await db.execute(
        `INSERT INTO message_deliveries (project_id, message_id, sender_id, recipient_id, sequence, status, delivered_at, acknowledged_at)
         VALUES (?, ?, 'ep-alice', 'ep-bob', ?, 'ACKNOWLEDGED', ?, ?)`,
        [projectId, mId, i, pastTime, pastTime]
      );
    }

    // Run housekeeping bounded to maxItemsPerRun: 4
    const report = await runHousekeeping(db, {
      projectId,
      retentionDays: 30,
      maxItemsPerRun: 4,
    });

    // Exactly 4 items should have been processed in this bounded batch
    expect(report.archivedDeliveries).toBe(4);

    // 6 remain in active deliveries
    const activeCount = await db.queryFirst<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM message_deliveries WHERE project_id = ?`,
      [projectId]
    );
    expect(activeCount?.cnt).toBe(6);
  });

  // Finding 5: Recoverable backups outside primary database
  it('recovers data from external filesystem backup even if primary database is wiped', async () => {
    // 1. Alice sends message
    await service.sendMessage(alice, {
      id: 'vital-secret-doc',
      recipientType: 'endpoint',
      recipientId: bob.endpointId,
      kind: 'confidential.v1',
      subject: 'Critical Data',
      payload: { blueprint: 'switchboard' },
    });

    // 2. Create backup
    const backup = await service.createScheduledBackup(projectId);
    expect(backup.storageType).toBe('local_external');

    // Verify listBackups returns local_external
    const localList = await service.listBackups(admin);
    expect(localList[0]?.storageType).toBe('local_external');

    // Verify hosted profile explicitly distinguishes hosted_database
    const hostedService = new SwitchboardService(db, undefined, null);
    const hostedBackup = await hostedService.createScheduledBackup(projectId);
    expect(hostedBackup.storageType).toBe('hosted_database');
    const hostedList = await hostedService.listBackups(admin);
    const foundHosted = hostedList.find((b) => b.id === hostedBackup.id);
    expect(foundHosted?.storageType).toBe('hosted_database');

    // Verify backup file was written to disk outside database
    const backupFilePath = path.join(testBackupDir, projectId, `${backup.id}.json`);
    const fileExists = await fs.access(backupFilePath).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);

    // 3. Catastrophic disaster: primary database completely destroyed (including backups table)
    await db.execute(`DELETE FROM backups WHERE project_id = ?`, [projectId]);
    await db.execute(`DELETE FROM message_deliveries WHERE project_id = ?`, [projectId]);
    await db.execute(`DELETE FROM messages WHERE project_id = ?`, [projectId]);

    const dbBackups = await db.query(`SELECT id FROM backups WHERE project_id = ?`, [projectId]);
    expect(dbBackups).toHaveLength(0);

    // 4. Restore from backup (loads from external FileBackupStorage)
    const restoreResult = await service.restoreFromBackup(admin, backup.id);
    expect(restoreResult.importedCount).toBeGreaterThan(0);

    // 5. Verify message recovered
    const recovered = await service.getMessage(bob, 'vital-secret-doc');
    expect(recovered).toBeDefined();
    expect(recovered.subject).toBe('Critical Data');
    expect(recovered.payload).toEqual({ blueprint: 'switchboard' });
  });

  // Finding 6: Correct budget limits and cycle rollover for hosting plan
  it('validates budget limits match hosting free tier and rolls over accounting cycle after 30 days', async () => {
    // Check default limits
    expect(DEFAULT_BUDGET_LIMITS.maxRequests).toBe(3_000_000); // 100k/day * 30 days
    expect(DEFAULT_BUDGET_LIMITS.maxRowsWritten).toBe(3_000_000); // 100k writes/day * 30 days
    expect(DEFAULT_BUDGET_LIMITS.maxStorageBytes).toBe(500_000_000); // 500 MB safe allocation

    const budget = BudgetManager.getInstance();
    await budget.recordUsage(db, projectId, { requests: 100, rowsWritten: 50 });

    let report = await budget.getReport(db, projectId);
    expect(report.requestCount).toBe(100);

    // Simulate 31 days elapsed
    const thirtyOneDaysAgo = Date.now() - 31 * 86_400_000;
    await db.execute(`UPDATE usage_accounting SET cycle_start_at = ? WHERE project_id = ?`, [
      thirtyOneDaysAgo,
      projectId,
    ]);

    // Query report: cycle rollover should automatically reset counters to 0
    report = await budget.getReport(db, projectId);
    expect(report.requestCount).toBe(0);
    expect(report.rowsWritten).toBe(0);
    expect(report.status).toBe('HEALTHY');
  });

  // Finding 7: Ensure exhausted budgets cannot prevent recipients from retrieving or acknowledging messages
  it('guarantees that budget exhaustion never blocks inbound message retrieval or delivery acknowledgements', async () => {
    const budget = BudgetManager.getInstance();

    // 1. Alice sends message while budget is healthy
    const msg = await service.sendMessage(alice, {
      id: 'pre-exhaustion-msg',
      recipientType: 'endpoint',
      recipientId: bob.endpointId,
      kind: 'msg.v1',
      subject: 'Pre-exhaustion',
      payload: { hello: 'bob' },
    });
    expect(msg.status).toBe('STORED');

    // 2. Set tight budget limit and exceed 100%
    await budget.setLimits(db, projectId, { maxRequests: 10, maxRowsWritten: 10 });
    await budget.recordUsage(db, projectId, { requests: 20 });

    const budgetReport = await budget.getReport(db, projectId);
    expect(budgetReport.status).toBe('EXCEEDED_100');

    // 3. Alice attempts to send a new NON-URGENT message -> blocked by budget throttle
    await expect(
      service.sendMessage(alice, {
        id: 'new-non-urgent',
        recipientType: 'endpoint',
        recipientId: bob.endpointId,
        kind: 'msg.v1',
        subject: 'Should be throttled',
        payload: {},
        priority: 'normal',
      })
    ).rejects.toThrow(SwitchboardError);

    // 4. CRITICAL INVARIANT: Bob (recipient) calls sync() to retrieve incoming message
    // Exhausted budget MUST NOT prevent Bob from retrieving messages!
    const bobSync = await service.sync(bob, {});
    expect(bobSync.inboundMessages).toHaveLength(1);
    expect(bobSync.inboundMessages[0]!.id).toBe('pre-exhaustion-msg');

    // 5. CRITICAL INVARIANT: Bob acknowledges delivery during exhausted budget
    // Exhausted budget MUST NOT prevent acknowledgements!
    const ackReceipts = await service.acknowledge(bob, [
      { messageId: 'pre-exhaustion-msg', senderId: alice.endpointId, note: 'Received during throttle' },
    ]);
    expect(ackReceipts).toHaveLength(1);
    expect(ackReceipts[0]!.status).toBe('ACKNOWLEDGED');

    // 6. In a combined sync call containing both an ack and an outgoing non-urgent message:
    // The outgoing message receives an item-level THROTTLED error, but the ack succeeds!
    const combinedSync = await service.sync(bob, {
      outgoingMessages: [
        {
          id: 'blocked-outbound-in-sync',
          recipientType: 'endpoint',
          recipientId: alice.endpointId,
          kind: 'msg.v1',
          subject: 'Blocked Outbound',
          payload: {},
          priority: 'normal',
        },
      ],
      acknowledgements: [
        { messageId: 'pre-exhaustion-msg', senderId: alice.endpointId },
      ],
    });

    expect(combinedSync.errors).toHaveLength(1);
    expect(combinedSync.errors[0]!.code).toBe('THROTTLED');
    expect(combinedSync.acknowledgedReceipts).toHaveLength(1);
  });
});
