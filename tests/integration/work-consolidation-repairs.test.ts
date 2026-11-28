import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { WorkService } from '../../src/work/work-service.js';
import type { AuthPrincipal } from '../../src/core/types.js';

/**
 * SWB-CONSOLIDATE-001 Phase C repairs — targeted regression evidence.
 *
 * C1: resolution requires a recorded stop handoff while an executor owns work.
 * C2: replays bind caller, operation type, target and canonical content;
 *     receipts stay stable after later resolution, reopen or transfer.
 * C3: explicit authorised commissioner handover.
 * C4: totals distinguish candidates from outstanding work; an explicit
 *     revision-safe disposition clears the deferred marker.
 * C6: export/import and backup/restore preserve work records and receipts.
 */
describe('Sweep consolidation repairs (SWB-CONSOLIDATE-001)', () => {
  const projectId = 'proj-repairs';
  let db: SqliteAdapter;
  let auth: AuthService;
  let service: SwitchboardService;
  let work: WorkService;
  let lucy: AuthPrincipal;
  let comm: AuthPrincipal;
  let maker: AuthPrincipal;
  let peer: AuthPrincipal;

  beforeEach(async () => {
    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    auth = new AuthService(db);
    service = new SwitchboardService(db);
    work = new WorkService(db);

    await auth.createProject(projectId, 'Repairs');
    await auth.registerEndpoint(projectId, 'lucy', 'Lucy', 'admin');
    await auth.registerEndpoint(projectId, 'comm', 'Commissioner', 'agent');
    await auth.registerEndpoint(projectId, 'maker', 'Maker', 'agent');
    await auth.registerEndpoint(projectId, 'peer', 'Peer', 'agent');
    await auth.issueToken(projectId, 'lucy', 'tok-lucy');
    await auth.issueToken(projectId, 'comm', 'tok-comm');
    await auth.issueToken(projectId, 'maker', 'tok-maker');
    await auth.issueToken(projectId, 'peer', 'tok-peer');
    lucy = await auth.authenticate('Bearer tok-lucy');
    comm = await auth.authenticate('Bearer tok-comm');
    maker = await auth.authenticate('Bearer tok-maker');
    peer = await auth.authenticate('Bearer tok-peer');
  });

  it('C1: closing work with a pending stop request requires a recorded handoff first', async () => {
    await work.commission(comm, {
      id: 'c1-work',
      operationId: 'op-c1-commission',
      objective: 'Stop me before closing',
      priority: 'normal',
    });
    await work.claim(maker, { workId: 'c1-work', operationId: 'op-c1-claim', expectedRevision: 1 });
    await work.transition(maker, {
      workId: 'c1-work',
      operationId: 'op-c1-start',
      expectedRevision: 2,
      toState: 'IN_PROGRESS',
    });
    await work.requestStop(comm, {
      workId: 'c1-work',
      operationId: 'op-c1-stop',
      expectedRevision: 3,
      reason: 'Direction changed',
    });

    const detail = await work.get(comm, 'c1-work');
    await expect(
      work.resolve(comm, {
        workId: 'c1-work',
        operationId: 'op-c1-resolve-early',
        expectedRevision: detail.work.revision,
        reason: 'CANCELLED',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // A transfer does not waive the handoff either: the obligation persists.
    await work.transfer(comm, {
      workId: 'c1-work',
      operationId: 'op-c1-transfer',
      expectedRevision: detail.work.revision,
      toExecutorId: 'peer',
      note: 'Peer takes over the stopped work',
    });
    const afterTransfer = await work.get(comm, 'c1-work');
    await expect(
      work.resolve(comm, {
        workId: 'c1-work',
        operationId: 'op-c1-resolve-early-2',
        expectedRevision: afterTransfer.work.revision,
        reason: 'CANCELLED',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await work.recordStopHandoff(peer, {
      workId: 'c1-work',
      operationId: 'op-c1-handoff',
      expectedRevision: afterTransfer.work.revision,
      note: 'Partial work preserved on branch feat/c1',
    });
    const ready = await work.get(comm, 'c1-work');
    const closed = await work.resolve(comm, {
      workId: 'c1-work',
      operationId: 'op-c1-resolve',
      expectedRevision: ready.work.revision,
      reason: 'OBSOLETE',
    });
    expect(closed.state).toBe('RESOLVED');
    expect(closed.resolutionReason).toBe('OBSOLETE');
  });

  it('C1: unclaimed work with a stop request resolves directly (nothing to hand off)', async () => {
    await work.commission(comm, {
      id: 'c1-idle',
      operationId: 'op-c1-idle-commission',
      objective: 'Nobody started this',
      priority: 'low',
    });
    const detail = await work.get(comm, 'c1-idle');
    await work.requestStop(comm, {
      workId: 'c1-idle',
      operationId: 'op-c1-idle-stop',
      expectedRevision: detail.work.revision,
      reason: 'No longer wanted',
    });
    const pending = await work.get(comm, 'c1-idle');
    const closed = await work.resolve(comm, {
      workId: 'c1-idle',
      operationId: 'op-c1-idle-resolve',
      expectedRevision: pending.work.revision,
      reason: 'CANCELLED',
    });
    expect(closed.state).toBe('RESOLVED');
  });

  it('C2: same operation id with different content is a conflict, not a replay', async () => {
    await work.commission(comm, {
      id: 'c2-work',
      operationId: 'op-c2-commission',
      objective: 'Binding probe',
      priority: 'normal',
    });
    const first = await work.claim(maker, {
      workId: 'c2-work',
      operationId: 'op-c2-claim',
      expectedRevision: 1,
      note: 'original note',
    });
    expect(first.isReplay).toBe(false);

    // Identical retry returns the original receipt.
    const replay = await work.claim(maker, {
      workId: 'c2-work',
      operationId: 'op-c2-claim',
      expectedRevision: 1,
      note: 'original note',
    });
    expect(replay.isReplay).toBe(true);
    expect(replay.eventSeq).toBe(first.eventSeq);

    // Same id, different content: conflict, no state change.
    await expect(
      work.claim(maker, {
        workId: 'c2-work',
        operationId: 'op-c2-claim',
        expectedRevision: 1,
        note: 'different note',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const detail = await work.get(comm, 'c2-work');
    expect(detail.work.revision).toBe(2);
    expect(detail.events.filter((e) => e.operationId === 'op-c2-claim')).toHaveLength(1);
  });

  it('C2: an unauthorised principal gets no replay receipt', async () => {
    await work.commission(comm, {
      id: 'c2-guard',
      operationId: 'op-c2g-commission',
      objective: 'Guarded replay',
      priority: 'normal',
    });
    await work.claim(maker, { workId: 'c2-guard', operationId: 'op-c2g-claim', expectedRevision: 1 });
    await work.transition(maker, {
      workId: 'c2-guard',
      operationId: 'op-c2g-submit',
      expectedRevision: 2,
      toState: 'SUBMITTED',
    });
    const resolved = await work.resolve(comm, {
      workId: 'c2-guard',
      operationId: 'op-c2g-resolve',
      expectedRevision: 3,
      reason: 'COMPLETED',
    });
    expect(resolved.state).toBe('RESOLVED');

    // Peer is neither commissioner nor steward: no receipt, even for an
    // otherwise valid replay of the original resolve.
    await expect(
      work.resolve(peer, {
        workId: 'c2-guard',
        operationId: 'op-c2g-resolve',
        expectedRevision: 3,
        reason: 'COMPLETED',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('C2: receipts stay stable after reopening and transfer', async () => {
    await work.commission(comm, {
      id: 'c2-stable',
      operationId: 'op-c2s-commission',
      objective: 'Stable receipt',
      priority: 'normal',
    });
    await work.claim(maker, { workId: 'c2-stable', operationId: 'op-c2s-claim', expectedRevision: 1 });
    await work.transition(maker, {
      workId: 'c2-stable',
      operationId: 'op-c2s-submit',
      expectedRevision: 2,
      toState: 'SUBMITTED',
    });
    await work.resolve(comm, {
      workId: 'c2-stable',
      operationId: 'op-c2s-resolve',
      expectedRevision: 3,
      reason: 'COMPLETED',
    });
    const reopened = await work.reopen(comm, {
      workId: 'c2-stable',
      operationId: 'op-c2s-reopen',
      expectedRevision: 4,
      reason: 'Regression reported',
    });
    expect(reopened.state).toBe('CLAIMED');

    // The historical RESOLVED event still carries its own reason.
    const detail = await work.get(comm, 'c2-stable');
    const resolution = detail.events.find((e) => e.eventType === 'RESOLVED');
    expect(resolution?.resultingResolutionReason).toBe('COMPLETED');

    // Replaying the original resolve returns the original stable receipt.
    const replayed = await work.resolve(comm, {
      workId: 'c2-stable',
      operationId: 'op-c2s-resolve',
      expectedRevision: 3,
      reason: 'COMPLETED',
    });
    expect(replayed.isReplay).toBe(true);
    expect(replayed.resolutionReason).toBe('COMPLETED');
  });

  it('C3: commissionership transfers explicitly; the old commissioner loses authority', async () => {
    await work.commission(comm, {
      id: 'c3-work',
      operationId: 'op-c3-commission',
      objective: 'Handover probe',
      priority: 'normal',
    });
    const detail = await work.get(comm, 'c3-work');
    const receipt = await work.transferCommissionership(comm, {
      workId: 'c3-work',
      operationId: 'op-c3-handover',
      expectedRevision: detail.work.revision,
      toCommissionerId: 'maker',
      note: 'Maker owns this commission now',
    });
    expect(receipt.eventType).toBe('COMMISSION_TRANSFERRED');

    const after = await work.get(maker, 'c3-work');
    expect(after.work.commissionerId).toBe('maker');
    expect(after.events.at(-1)?.eventType).toBe('COMMISSION_TRANSFERRED');

    // The previous commissioner can no longer resolve.
    await expect(
      work.resolve(comm, {
        workId: 'c3-work',
        operationId: 'op-c3-forged',
        expectedRevision: after.work.revision,
        reason: 'CANCELLED',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // The new commissioner can.
    const closed = await work.resolve(maker, {
      workId: 'c3-work',
      operationId: 'op-c3-resolve',
      expectedRevision: after.work.revision,
      reason: 'OBSOLETE',
    });
    expect(closed.state).toBe('RESOLVED');
  });

  it('C4: totals are explicit and an authorised disposition clears the deferred marker', async () => {
    await work.commission(comm, {
      id: 'c4-first',
      operationId: 'op-c4-first',
      objective: 'First sync slice',
      scopeRefs: ['src/core/sync'],
      priority: 'normal',
    });
    const second = await work.commission(comm, {
      id: 'c4-second',
      operationId: 'op-c4-second',
      objective: 'Second sync slice',
      scopeRefs: ['src/core/sync'],
      priority: 'normal',
    });
    expect(second.reconciliationDeferred).toBe(true);

    const related = await work.relatedWork(comm, { scopeRefs: ['src/core/sync'], limit: 1 });
    expect(related.candidates).toHaveLength(1);
    expect(related.outstandingCount).toBeGreaterThanOrEqual(2);
    expect(related.truncated).toBe(true);
    // At commission time only one candidate existed, so nothing was omitted there.
    expect(second.relatedTruncated).toBe(false);

    const board = await work.board(comm);
    expect(board.counts.reconciliationCandidates).toBeGreaterThanOrEqual(1);

    const recorded = await work.resolveReconciliation(comm, {
      workId: 'c4-second',
      operationId: 'op-c4-reconcile',
      expectedRevision: second.work.revision,
      decision: 'retained',
      note: 'Both slices stay open; second supersedes nothing',
    });
    expect(recorded.eventType).toBe('RECONCILIATION_RECORDED');

    const after = await work.get(comm, 'c4-second');
    expect(after.work.reconciliationDeferred).toBe(false);

    const boardAfter = await work.board(comm);
    expect(boardAfter.counts.reconciliationCandidates).toBe(board.counts.reconciliationCandidates - 1);

    // Recording again without a deferred marker is a conflict, not a no-op.
    await expect(
      work.resolveReconciliation(comm, {
        workId: 'c4-second',
        operationId: 'op-c4-reconcile-2',
        expectedRevision: after.work.revision,
        decision: 'retained',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('C6: export and import preserve work records, history and stable receipts', async () => {
    await work.commission(comm, {
      id: 'c6-work',
      operationId: 'op-c6-commission',
      objective: 'Survive a restore',
      scopeRefs: ['src/work'],
      priority: 'normal',
      acceptanceCriteria: ['restored intact'],
    });
    await work.claim(maker, { workId: 'c6-work', operationId: 'op-c6-claim', expectedRevision: 1 });
    await work.transition(maker, {
      workId: 'c6-work',
      operationId: 'op-c6-start',
      expectedRevision: 2,
      toState: 'IN_PROGRESS',
    });

    const exported = await service.exportData(comm);
    expect(exported.workItems?.map((w) => w.id)).toContain('c6-work');
    expect(exported.workEvents?.filter((e) => e.workId === 'c6-work')).toHaveLength(3);
    expect(exported.workEvents?.every((e) => typeof e.operationHash === 'string')).toBe(true);

    const target = new SqliteAdapter(':memory:');
    await initializeSchema(target);
    const targetAuth = new AuthService(target);
    await targetAuth.createProject(projectId, 'Repairs');
    const targetService = new SwitchboardService(target);
    const res = await targetService.importData(
      { endpointId: 'lucy', projectId, scopes: ['read', 'write'], role: 'admin' },
      exported
    );
    expect(res.importedCount).toBeGreaterThanOrEqual(1);

    const targetWork = new WorkService(target);
    const restored = await targetWork.get(
      { endpointId: 'lucy', projectId, scopes: ['read', 'write'], role: 'admin' },
      'c6-work'
    );
    expect(restored.work.state).toBe('IN_PROGRESS');
    expect(restored.work.executorId).toBe('maker');
    expect(restored.work.acceptanceCriteria).toEqual(['restored intact']);
    expect(restored.events.map((e) => e.eventType)).toEqual(['COMMISSIONED', 'CLAIMED', 'STATE_CHANGED']);
    expect(restored.events.every((e) => typeof e.operationHash === 'string')).toBe(true);

    // A backup round-trips the same manifest.
    const backup = await service.createScheduledBackup(projectId);
    const restoredBackup = await service.restoreFromBackup(lucy, backup.id);
    expect(restoredBackup.backupId).toBe(backup.id);
  });

  it('migration 0003 upgrades a pre-repair database and backfills resolved reasons', async () => {
    const legacy = new SqliteAdapter(':memory:');
    const migration1 = readFileSync('src/db/migrations/0001_initial_schema.sql', 'utf8');
    const migration2 = readFileSync('src/db/migrations/0002_work_records.sql', 'utf8');
    const migration3 = readFileSync('src/db/migrations/0003_work_event_receipts.sql', 'utf8');
    await legacy.exec(migration1);
    await legacy.exec(migration2);
    await legacy.execute(
      `INSERT INTO work_items (project_id, id, state, resolution_reason, priority, objective, commissioner_id, commissioner_role, revision, last_event_seq, created_at, updated_at)
       VALUES ('p', 'w', 'RESOLVED', 'COMPLETED', 'normal', 'legacy objective', 'comm', 'agent', 2, 2, 1, 1)`
    );
    await legacy.execute(
      `INSERT INTO work_events (project_id, work_id, seq, event_type, from_state, to_state, actor_id, actor_role, reason, operation_id, resulting_revision, created_at)
       VALUES ('p', 'w', 1, 'COMMISSIONED', NULL, 'UNCLAIMED', 'comm', 'agent', 'COMMISSIONED', 'op-legacy-1', 1, 1),
              ('p', 'w', 2, 'RESOLVED', 'SUBMITTED', 'RESOLVED', 'comm', 'agent', 'COMPLETED', 'op-legacy-2', 2, 2)`
    );
    await legacy.exec(migration3);

    const backfilled = await legacy.queryFirst<{ resulting_resolution_reason: string }>(
      `SELECT resulting_resolution_reason FROM work_events WHERE project_id = 'p' AND operation_id = 'op-legacy-2'`
    );
    expect(backfilled?.resulting_resolution_reason).toBe('COMPLETED');
    const commissioned = await legacy.queryFirst<{ operation_hash: unknown }>(
      `SELECT operation_hash FROM work_events WHERE project_id = 'p' AND operation_id = 'op-legacy-1'`
    );
    expect(commissioned?.operation_hash).toBeNull();
  });
});
