import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { WorkService } from '../../src/work/work-service.js';
import { runHousekeeping } from '../../src/operations/housekeeping.js';
import type { AuthPrincipal } from '../../src/core/types.js';

/**
 * SWB-SWEEP-001 S1 — work lifecycle semantics.
 *
 * These tests exercise real persisted state through the public domain methods.
 * Each one names the acceptance item it evidences.
 */
describe('Work lifecycle (SWB-SWEEP-001)', () => {
  const projectId = 'proj-sweep';
  let db: SqliteAdapter;
  let auth: AuthService;
  let service: SwitchboardService;
  let work: WorkService;
  let lucy: AuthPrincipal;
  let workerA: AuthPrincipal;
  let workerB: AuthPrincipal;
  let workerX: AuthPrincipal;
  let stranger: AuthPrincipal;

  beforeEach(async () => {
    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    auth = new AuthService(db);
    service = new SwitchboardService(db);
    work = new WorkService(db);

    await auth.createProject(projectId, 'Sweep Project');
    await auth.registerEndpoint(projectId, 'lucy', 'Lucy', 'admin');
    await auth.registerEndpoint(projectId, 'worker-a', 'Worker A', 'agent');
    await auth.registerEndpoint(projectId, 'worker-b', 'Worker B', 'agent');
    await auth.registerEndpoint(projectId, 'worker-x', 'Worker X', 'agent');
    await auth.issueToken(projectId, 'lucy', 'tok-lucy');
    await auth.issueToken(projectId, 'worker-a', 'tok-worker-a');
    await auth.issueToken(projectId, 'worker-b', 'tok-worker-b');
    await auth.issueToken(projectId, 'worker-x', 'tok-worker-x');

    await auth.createProject('proj-other', 'Other Project');
    await auth.registerEndpoint('proj-other', 'stranger', 'Stranger', 'admin');
    await auth.issueToken('proj-other', 'stranger', 'tok-stranger');

    lucy = await auth.authenticate('Bearer tok-lucy');
    workerA = await auth.authenticate('Bearer tok-worker-a');
    workerB = await auth.authenticate('Bearer tok-worker-b');
    workerX = await auth.authenticate('Bearer tok-worker-x');
    stranger = await auth.authenticate('Bearer tok-stranger');
  });

  async function commissionBasic(id: string, extra: Record<string, unknown> = {}) {
    return await work.commission(lucy, {
      id,
      operationId: `op-commission-${id}`,
      objective: `Deliver ${id} for the sync path`,
      scopeRefs: ['src/core/sync'],
      priority: 'normal',
      executorId: null,
      acceptanceCriteria: ['targeted regression passes'],
      ...extra,
    });
  }

  it('keeps an old unanswered assignment active after its delivery ages out (acceptance 1)', async () => {
    const sent = await service.sendMessage(lucy, {
      id: 'msg-old-assignment',
      recipientType: 'endpoint',
      recipientId: 'worker-a',
      kind: 'task.request.v1',
      subject: 'Please do the old thing',
      payload: { detail: 'unanswered' },
    });
    expect(sent.status).toBe('STORED');

    const commissioned = await commissionBasic('work-old', { sourceMessageId: 'msg-old-assignment' });
    expect(commissioned.work.state).toBe('UNCLAIMED');

    // Age and delivery expiry must not touch the obligation.
    const report = await runHousekeeping(db, { projectId, retentionDays: 0, deadLetterAgeDays: 0 });
    expect(report.deadLetteredDeliveries).toBe(1);

    const stillThere = await work.get(lucy, 'work-old');
    expect(stillThere.work.state).toBe('UNCLAIMED');
    expect(stillThere.work.resolutionReason).toBeNull();
    expect(stillThere.work.archivedAt).toBeNull();

    const board = await work.board(lucy);
    expect(board.counts.unclaimed).toBe(1);
    expect(board.deliveries.deadLettered).toBe(1);
    expect(board.unclaimed.map((item) => item.workId)).toContain('work-old');
  });

  it('supersedes an old assignment without losing either history or responsibility (acceptance 2)', async () => {
    await commissionBasic('work-a', { scopeRefs: ['src/core/sync', 'src/db'] });
    const replacement = await work.commission(lucy, {
      id: 'work-b',
      operationId: 'op-commission-work-b',
      objective: 'Replace work-a with a narrower sync change',
      scopeRefs: ['src/core/sync'],
      priority: 'normal',
      executorId: 'worker-b',
      supersedesWorkId: 'work-a',
      supersedesExpectedRevision: 1,
    });

    expect(replacement.work.replacesWorkId).toBe('work-a');
    const old = await work.get(lucy, 'work-a');
    expect(old.work.state).toBe('RESOLVED');
    expect(old.work.resolutionReason).toBe('SUPERSEDED');
    expect(old.work.supersededByWorkId).toBe('work-b');
    expect(old.events.map((e) => e.eventType)).toEqual(['COMMISSIONED', 'RESOLVED']);
    expect(old.events[1]?.reason).toBe('SUPERSEDED');

    const fresh = await work.get(lucy, 'work-b');
    expect(fresh.work.state).toBe('CLAIMED');
    expect(fresh.work.executorId).toBe('worker-b');
    expect(fresh.events).toHaveLength(1);
  });

  it('refuses a supersession target that is already resolved, creating nothing (acceptance 2, 8)', async () => {
    await commissionBasic('work-done');
    await work.claim(workerA, { workId: 'work-done', operationId: 'op-claim-done', expectedRevision: 1 });
    await work.transition(workerA, {
      workId: 'work-done',
      operationId: 'op-submit-done',
      expectedRevision: 2,
      toState: 'SUBMITTED',
    });
    await work.resolve(lucy, {
      workId: 'work-done',
      operationId: 'op-resolve-done',
      expectedRevision: 3,
      reason: 'COMPLETED',
    });

    await expect(
      work.commission(lucy, {
        id: 'work-late',
        operationId: 'op-commission-late',
        objective: 'Late replacement',
        priority: 'normal',
        supersedesWorkId: 'work-done',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(work.get(lucy, 'work-late')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("keeps an absent executor's obligation recoverable through explicit transfer (acceptance 3)", async () => {
    const commissioned = await work.commission(lucy, {
      id: 'work-x',
      operationId: 'op-commission-work-x',
      objective: 'Rebuild the dead-letter recovery path',
      priority: 'normal',
      executorId: 'worker-x',
      scopeRefs: ['src/operations'],
    });
    expect(commissioned.work.executorId).toBe('worker-x');

    // worker-x never reports anything; the obligation must not decay.
    const beforeTransfer = await work.get(lucy, 'work-x');
    expect(beforeTransfer.work.state).toBe('CLAIMED');

    const receipt = await work.transfer(lucy, {
      workId: 'work-x',
      operationId: 'op-transfer-work-x',
      expectedRevision: beforeTransfer.work.revision,
      toExecutorId: 'worker-b',
      note: 'worker-x is offline and replaced; Worker B takes the obligation',
    });
    expect(receipt.isReplay).toBe(false);
    expect(receipt.state).toBe('CLAIMED');

    const after = await work.get(lucy, 'work-x');
    expect(after.work.executorId).toBe('worker-b');
    expect(after.work.state).toBe('CLAIMED');
    expect(after.events.map((event) => event.eventType)).toEqual([
      'COMMISSIONED',
      'HANDOFF_TRANSFERRED',
    ]);
    expect(after.events[1]?.note).toContain('replaced');
  });

  it('does not treat delivery acknowledgement as work acceptance (acceptance 4)', async () => {
    await service.sendMessage(lucy, {
      id: 'msg-ack-is-not-acceptance',
      recipientType: 'endpoint',
      recipientId: 'worker-a',
      kind: 'task.request.v1',
      subject: 'Work with an acknowledged delivery',
      payload: { detail: 'x' },
    });
    await commissionBasic('work-ack');
    await work.claim(workerA, { workId: 'work-ack', operationId: 'op-claim-ack', expectedRevision: 1 });

    const acks = await service.acknowledge(workerA, [
      { messageId: 'msg-ack-is-not-acceptance', senderId: 'lucy' },
    ]);
    expect(acks).toHaveLength(1);

    const afterAck = await work.get(lucy, 'work-ack');
    expect(afterAck.work.state).toBe('CLAIMED');
    expect(afterAck.work.resolutionReason).toBeNull();

    // Completion still needs a submission and commissioner authority.
    await expect(
      work.resolve(lucy, {
        workId: 'work-ack',
        operationId: 'op-resolve-unsubmitted',
        expectedRevision: afterAck.work.revision,
        reason: 'COMPLETED',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('delivers a stop request to a busy executor and preserves partial work (acceptance 5)', async () => {
    await commissionBasic('work-busy');
    await work.claim(workerA, { workId: 'work-busy', operationId: 'op-claim-busy', expectedRevision: 1 });
    await work.transition(workerA, {
      workId: 'work-busy',
      operationId: 'op-start-busy',
      expectedRevision: 2,
      toState: 'IN_PROGRESS',
    });

    const stopReceipt = await work.requestStop(lucy, {
      workId: 'work-busy',
      operationId: 'op-stop-busy',
      expectedRevision: 3,
      reason: 'Direction changed; stop before continuing',
    });
    expect(stopReceipt.eventType).toBe('STOP_REQUESTED');

    const pending = await work.get(lucy, 'work-busy');
    expect(pending.work.state).toBe('IN_PROGRESS');
    expect(pending.work.stopRequestedAt).not.toBeNull();
    expect(pending.work.stopReason).toContain('Direction changed');

    const closedByRequest = await work.board(lucy);
    expect(closedByRequest.stopRequests.map((item) => item.workId)).toContain('work-busy');

    const handoff = await work.recordStopHandoff(workerA, {
      workId: 'work-busy',
      operationId: 'op-handoff-busy',
      expectedRevision: pending.work.revision,
      note: 'Branch feat/busy holds partial work; no files were reverted',
      evidenceRefs: ['branch:feat/busy', 'evidence:diff-0042'],
    });
    expect(handoff.state).toBe('WAITING');

    const afterHandoff = await work.get(lucy, 'work-busy');
    expect(afterHandoff.work.state).toBe('WAITING');
    expect(afterHandoff.work.stopHandoffAt).not.toBeNull();
    expect(afterHandoff.work.resolutionReason).toBeNull();
    const handoffEvent = afterHandoff.events.at(-1);
    expect(handoffEvent?.eventType).toBe('STOP_HANDOFF_RECORDED');
    expect(handoffEvent?.evidenceRefs).toContain('evidence:diff-0042');
  });

  it('refuses closure, transfer and inspection to unauthorised principals (acceptance 6)', async () => {
    await commissionBasic('work-guarded');
    const current = await work.get(lucy, 'work-guarded');

    await expect(
      work.resolve(workerB, {
        workId: 'work-guarded',
        operationId: 'op-forged-close',
        expectedRevision: current.work.revision,
        reason: 'CANCELLED',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      work.transfer(workerB, {
        workId: 'work-guarded',
        operationId: 'op-forged-transfer',
        expectedRevision: current.work.revision,
        toExecutorId: 'worker-b',
        note: 'I take this',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(work.get(stranger, 'work-guarded')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      work.resolve(stranger, {
        workId: 'work-guarded',
        operationId: 'op-cross-project-close',
        expectedRevision: current.work.revision,
        reason: 'CANCELLED',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const untouched = await work.get(lucy, 'work-guarded');
    expect(untouched.work.state).toBe('UNCLAIMED');
    expect(untouched.events).toHaveLength(1);

    // The authorised commissioner may still close it, with a reason and a receipt.
    const closed = await work.resolve(lucy, {
      workId: 'work-guarded',
      operationId: 'op-authorised-cancel',
      expectedRevision: untouched.work.revision,
      reason: 'CANCELLED',
      note: 'Superseded by the new workshop plan',
    });
    expect(closed.state).toBe('RESOLVED');
  });

  it('makes replayed operations return the original receipt without duplicating or reversing (acceptance 7)', async () => {
    await commissionBasic('work-replay');

    const first = await work.claim(workerA, {
      workId: 'work-replay',
      operationId: 'op-claim-replay',
      expectedRevision: 1,
    });
    const replay = await work.claim(workerA, {
      workId: 'work-replay',
      operationId: 'op-claim-replay',
      expectedRevision: 1,
    });
    expect(replay.isReplay).toBe(true);
    expect(replay.eventSeq).toBe(first.eventSeq);
    expect(replay.revision).toBe(first.revision);

    const detail = await work.get(lucy, 'work-replay');
    expect(detail.work.revision).toBe(2);
    expect(detail.events.filter((event) => event.operationId === 'op-claim-replay')).toHaveLength(1);

    const replayedResolve = await work.resolve(lucy, {
      workId: 'work-replay',
      operationId: 'op-resolve-replay',
      expectedRevision: 2,
      reason: 'OBSOLETE',
    });
    const replay2 = await work.resolve(lucy, {
      workId: 'work-replay',
      operationId: 'op-resolve-replay',
      expectedRevision: 2,
      reason: 'OBSOLETE',
    });
    expect(replay2.isReplay).toBe(true);
    expect(replay2.revision).toBe(replayedResolve.revision);

    const afterReplays = await work.get(lucy, 'work-replay');
    expect(afterReplays.work.state).toBe('RESOLVED');
    expect(afterReplays.work.resolutionReason).toBe('OBSOLETE');
    expect(afterReplays.events).toHaveLength(3);
  });

  it('produces one explicit winner and one explicit conflict for concurrent edits (acceptance 8)', async () => {
    await commissionBasic('work-race');
    await work.claim(workerA, { workId: 'work-race', operationId: 'op-claim-race', expectedRevision: 1 });
    await work.transition(workerA, {
      workId: 'work-race',
      operationId: 'op-submit-race',
      expectedRevision: 2,
      toState: 'SUBMITTED',
    });

    const outcomes = await Promise.allSettled([
      work.transition(lucy, {
        workId: 'work-race',
        operationId: 'op-review-race',
        expectedRevision: 3,
        toState: 'REVIEW',
      }),
      work.transition(lucy, {
        workId: 'work-race',
        operationId: 'op-rework-race',
        expectedRevision: 3,
        toState: 'IN_PROGRESS',
      }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });

    const settled = await work.get(lucy, 'work-race');
    expect(settled.work.revision).toBe(4);
    expect(['REVIEW', 'IN_PROGRESS']).toContain(settled.work.state);
    // Exactly one of the two competing operations left a durable event.
    const competing = settled.events.filter((event) =>
      ['op-review-race', 'op-rework-race'].includes(event.operationId)
    );
    expect(competing).toHaveLength(1);
  });

  it('archives logically, keeps history retrievable and allows authorised reopening (acceptance 10)', async () => {
    await commissionBasic('work-archive');
    await work.claim(workerA, { workId: 'work-archive', operationId: 'op-claim-archive', expectedRevision: 1 });
    await work.transition(workerA, {
      workId: 'work-archive',
      operationId: 'op-submit-archive',
      expectedRevision: 2,
      toState: 'SUBMITTED',
    });
    await work.resolve(lucy, {
      workId: 'work-archive',
      operationId: 'op-resolve-archive',
      expectedRevision: 3,
      reason: 'COMPLETED',
    });
    const archived = await work.archive(lucy, {
      workId: 'work-archive',
      operationId: 'op-archive-archive',
      expectedRevision: 4,
    });
    expect(archived.state).toBe('RESOLVED');

    const defaultList = await work.list(lucy);
    expect(defaultList.items.map((item) => item.workId)).not.toContain('work-archive');

    const archivedList = await work.list(lucy, { includeArchived: true });
    expect(archivedList.items.map((item) => item.workId)).toContain('work-archive');

    const retrieved = await work.get(lucy, 'work-archive');
    expect(retrieved.work.archivedAt).not.toBeNull();
    expect(retrieved.work.resolutionReason).toBe('COMPLETED');
    expect(retrieved.events.map((event) => event.eventType)).toEqual([
      'COMMISSIONED',
      'CLAIMED',
      'STATE_CHANGED',
      'RESOLVED',
      'ARCHIVED',
    ]);

    await expect(
      work.reopen(workerB, {
        workId: 'work-archive',
        operationId: 'op-reopen-forged',
        expectedRevision: retrieved.work.revision,
        reason: 'I want it back',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const reopened = await work.reopen(lucy, {
      workId: 'work-archive',
      operationId: 'op-reopen-archive',
      expectedRevision: retrieved.work.revision,
      reason: 'Customer reported the fix regressed',
    });
    expect(reopened.state).toBe('CLAIMED');

    const afterReopen = await work.get(lucy, 'work-archive');
    expect(afterReopen.work.archivedAt).toBeNull();
    expect(afterReopen.work.resolutionReason).toBeNull();
    // Prior resolution stays in history rather than being rewritten.
    const resolution = afterReopen.events.find((event) => event.eventType === 'RESOLVED');
    expect(resolution?.reason).toBe('COMPLETED');
    expect(afterReopen.events.at(-1)?.eventType).toBe('REOPENED');
  });

  it('surfaces bounded related candidates and marks deferred reconciliation (contract D)', async () => {
    await commissionBasic('work-related-1', { scopeRefs: ['src/core/sync'] });
    await commissionBasic('work-related-2', { scopeRefs: ['src/db'] });

    const result = await work.commission(lucy, {
      id: 'work-related-3',
      operationId: 'op-commission-related-3',
      objective: 'Another sync change',
      scopeRefs: ['src/core/sync'],
      priority: 'urgent',
      executorId: null,
    });

    expect(result.relatedCandidates.length).toBeLessThanOrEqual(5);
    const ids = result.relatedCandidates.map((candidate) => candidate.workId);
    expect(ids).toContain('work-related-1');
    expect(result.relatedCandidates[0]?.matchReasons.join(' ')).toContain('scope-overlap');
    expect(result.reconciliationDeferred).toBe(true);
    expect(result.relatedCandidateCount).toBeGreaterThanOrEqual(2);

    const board = await work.board(lucy);
    // The two later commissions each had unresolved related work and recorded it.\n    expect(board.counts.reconciliationCandidates).toBe(2);

    // Bounded, deterministic retrieval with an explicit cap.
    const related = await work.relatedWork(lucy, { scopeRefs: ['src/core/sync'], limit: 1 });
    expect(related.candidates).toHaveLength(1);
    expect(related.outstandingCount).toBeGreaterThanOrEqual(3);
  });
});
