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

    // A conflicting transfer does not waive the handoff either.
    await expect(
      work.transfer(comm, {
        workId: 'c1-work',
        operationId: 'op-c1-transfer-early',
        expectedRevision: detail.work.revision,
        toExecutorId: 'peer',
        note: 'Peer takes over the stopped work',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // The current executor records the handoff; only then may the work move.
    await work.recordStopHandoff(maker, {
      workId: 'c1-work',
      operationId: 'op-c1-handoff',
      expectedRevision: detail.work.revision,
      note: 'Partial work preserved on branch feat/c1',
    });
    const handedOff = await work.get(comm, 'c1-work');
    await work.transfer(comm, {
      workId: 'c1-work',
      operationId: 'op-c1-transfer',
      expectedRevision: handedOff.work.revision,
      toExecutorId: 'peer',
      note: 'Peer takes over the stopped work',
    });
    // The transfer opened a new episode with cleared markers: the old
    // handoff proves nothing about the new ownership, so closing the work
    // needs a fresh handoff bound to the new episode and executor.
    const afterTransfer = await work.get(comm, 'c1-work');
    expect(afterTransfer.work.execEpisode).toBeGreaterThan(handedOff.work.execEpisode);
    expect(afterTransfer.work.stopOpen).toBe(false);
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
      operationId: 'op-c1-handoff-2',
      expectedRevision: afterTransfer.work.revision,
      note: 'Peer confirms partial work on branch feat/c1',
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

  it('C1: a stale handoff does not survive a new stop, a transfer or a reopen', async () => {
    async function startActive(id: string) {
      await work.commission(comm, {
        id,
        operationId: `op-${id}-commission`,
        objective: `Episode probe ${id}`,
        priority: 'normal',
      });
      const c = await work.get(comm, id);
      await work.claim(maker, { workId: id, operationId: `op-${id}-claim`, expectedRevision: c.work.revision });
      const k = await work.get(comm, id);
      await work.transition(maker, {
        workId: id,
        operationId: `op-${id}-start`,
        expectedRevision: k.work.revision,
        toState: 'IN_PROGRESS',
      });
      return await work.get(comm, id);
    }

    // New stop invalidates a prior handoff.
    let detail = await startActive('c1-stale');
    await work.requestStop(comm, { workId: 'c1-stale', operationId: 'op-c1s-stop1', expectedRevision: detail.work.revision, reason: 'First stop' });
    detail = await work.get(comm, 'c1-stale');
    await work.recordStopHandoff(maker, { workId: 'c1-stale', operationId: 'op-c1s-hand1', expectedRevision: detail.work.revision, note: 'Handoff one' });
    detail = await work.get(comm, 'c1-stale');
    await work.requestStop(comm, { workId: 'c1-stale', operationId: 'op-c1s-stop2', expectedRevision: detail.work.revision, reason: 'Second stop' });
    detail = await work.get(comm, 'c1-stale');
    expect(detail.work.stopOpen).toBe(true);
    await expect(
      work.resolve(comm, { workId: 'c1-stale', operationId: 'op-c1s-resolve-early', expectedRevision: detail.work.revision, reason: 'CANCELLED' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await work.recordStopHandoff(maker, { workId: 'c1-stale', operationId: 'op-c1s-hand2', expectedRevision: detail.work.revision, note: 'Handoff two' });
    detail = await work.get(comm, 'c1-stale');
    const closed = await work.resolve(comm, { workId: 'c1-stale', operationId: 'op-c1s-resolve', expectedRevision: detail.work.revision, reason: 'OBSOLETE' });
    expect(closed.state).toBe('RESOLVED');

    // Reopen starts a new episode with cleared markers; history is preserved.
    const reopened = await work.reopen(comm, { workId: 'c1-stale', operationId: 'op-c1s-reopen', expectedRevision: closed.revision, reason: 'Still needed' });
    expect(reopened.state).toBe('CLAIMED');
    const afterReopen = await work.get(comm, 'c1-stale');
    expect(afterReopen.work.stopRequestedAt).toBeNull();
    expect(afterReopen.work.stopHandoffAt).toBeNull();
    expect(afterReopen.work.execEpisode).toBe(detail.work.execEpisode + 1);
    const resolution = afterReopen.events.find((e) => e.eventType === 'RESOLVED');
    expect(resolution?.resultingResolutionReason).toBe('OBSOLETE');
    await expect(
      work.resolve(comm, { workId: 'c1-stale', operationId: 'op-c1s-resolve-2', expectedRevision: afterReopen.work.revision, reason: 'CANCELLED' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await work.recordStopHandoff(maker, { workId: 'c1-stale', operationId: 'op-c1s-hand3', expectedRevision: afterReopen.work.revision, note: 'Handoff for new episode' });
    const ready = await work.get(comm, 'c1-stale');
    const closedAgain = await work.resolve(comm, { workId: 'c1-stale', operationId: 'op-c1s-resolve-3', expectedRevision: ready.work.revision, reason: 'CANCELLED' });
    expect(closedAgain.state).toBe('RESOLVED');
  });

  async function startActive(id: string, objective: string) {
    await work.commission(comm, { id, operationId: `op-${id}-commission`, objective, priority: 'normal' });
    const c = await work.get(comm, id);
    await work.claim(maker, { workId: id, operationId: `op-${id}-claim`, expectedRevision: c.work.revision });
    const k = await work.get(comm, id);
    await work.transition(maker, { workId: id, operationId: `op-${id}-start`, expectedRevision: k.work.revision, toState: 'IN_PROGRESS' });
    return await work.get(comm, id);
  }

  it('C1: resuming execution invalidates the handoff for resolve', async () => {
    // Handoff, then resume: the binding dies with the resumed execution.
    let detail = await startActive('c1-resume', 'Resume probe');
    await work.recordStopHandoff(maker, { workId: 'c1-resume', operationId: 'op-c1r-hand', expectedRevision: detail.work.revision, note: 'Handoff before resume' });
    detail = await work.get(comm, 'c1-resume');
    expect(detail.work.state).toBe('WAITING');
    await work.transition(maker, { workId: 'c1-resume', operationId: 'op-c1r-restart', expectedRevision: detail.work.revision, toState: 'IN_PROGRESS' });
    detail = await work.get(comm, 'c1-resume');
    expect(detail.work.handoffEpisode).toBeNull();
    await expect(work.resolve(comm, { workId: 'c1-resume', operationId: 'op-c1r-resolve', expectedRevision: detail.work.revision, reason: 'CANCELLED' })).rejects.toMatchObject({ code: 'CONFLICT' });
    // A fresh handoff bound to the resumed execution re-opens closure.
    await work.recordStopHandoff(maker, { workId: 'c1-resume', operationId: 'op-c1r-hand2', expectedRevision: detail.work.revision, note: 'Handoff after resume' });
    detail = await work.get(comm, 'c1-resume');
    const closed = await work.resolve(comm, { workId: 'c1-resume', operationId: 'op-c1r-resolve2', expectedRevision: detail.work.revision, reason: 'OBSOLETE' });
    expect(closed.state).toBe('RESOLVED');
  });

  it('C1: resumed execution blocks conflicting transfer and supersession until a fresh handoff', async () => {
    let detail = await startActive('c1-resume-xfer', 'Resume transfer probe');
    await work.recordStopHandoff(maker, { workId: 'c1-resume-xfer', operationId: 'op-c1rx-hand', expectedRevision: detail.work.revision, note: 'Handoff before resume' });
    detail = await work.get(comm, 'c1-resume-xfer');
    await work.transition(maker, { workId: 'c1-resume-xfer', operationId: 'op-c1rx-restart', expectedRevision: detail.work.revision, toState: 'IN_PROGRESS' });
    detail = await work.get(comm, 'c1-resume-xfer');
    await work.commission(comm, { id: 'c1-resume-replacement', operationId: 'op-c1rx-repl', objective: 'Replacement', priority: 'normal' });
    await expect(work.transfer(comm, { workId: 'c1-resume-xfer', operationId: 'op-c1rx-transfer', expectedRevision: detail.work.revision, toExecutorId: 'peer', note: 'Take over after resume' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(work.supersede(comm, { workId: 'c1-resume-xfer', operationId: 'op-c1rx-supersede', expectedRevision: detail.work.revision, replacementWorkId: 'c1-resume-replacement', note: 'Supersede after resume' })).rejects.toMatchObject({ code: 'CONFLICT' });
    // A fresh handoff bound to the resumed execution re-opens transfer.
    await work.recordStopHandoff(maker, { workId: 'c1-resume-xfer', operationId: 'op-c1rx-hand2', expectedRevision: detail.work.revision, note: 'Handoff after resume' });
    detail = await work.get(comm, 'c1-resume-xfer');
    const moved = await work.transfer(comm, { workId: 'c1-resume-xfer', operationId: 'op-c1rx-transfer2', expectedRevision: detail.work.revision, toExecutorId: 'peer', note: 'Take over' });
    expect(moved.state).toBe('WAITING');
    const afterXfer = await work.get(comm, 'c1-resume-xfer');
    expect(afterXfer.work.executorId).toBe('peer');
  });

  it('C1: CLAIMED bypasses never resume execution, so a prior handoff still binds', async () => {
    await work.commission(comm, { id: 'c1-bypass', operationId: 'op-c1b-commission', objective: 'Bypass probe', priority: 'normal' });
    let detail = await work.get(comm, 'c1-bypass');
    await work.claim(maker, { workId: 'c1-bypass', operationId: 'op-c1b-claim', expectedRevision: detail.work.revision });
    detail = await work.get(comm, 'c1-bypass');
    await work.recordStopHandoff(maker, { workId: 'c1-bypass', operationId: 'op-c1b-hand', expectedRevision: detail.work.revision, note: 'Proactive handoff' });
    detail = await work.get(comm, 'c1-bypass');
    // recordStopHandoff already moved the work to WAITING; the bypasses
    // continue from there without ever resuming execution.
    for (const [op, toState] of [['op-c1b-b', 'BLOCKED'], ['op-c1b-w2', 'WAITING']] as const) {
      await work.transition(maker, { workId: 'c1-bypass', operationId: op, expectedRevision: detail.work.revision, toState });
      detail = await work.get(comm, 'c1-bypass');
      expect(detail.work.handoffEpisode).toBe(detail.work.execEpisode);
    }
    const submitted = await work.transition(maker, { workId: 'c1-bypass', operationId: 'op-c1b-s', expectedRevision: detail.work.revision, toState: 'SUBMITTED' });
    expect(submitted.state).toBe('SUBMITTED');
    const accepted = await work.resolve(comm, { workId: 'c1-bypass', operationId: 'op-c1b-resolve', expectedRevision: submitted.revision, reason: 'COMPLETED' });
    expect(accepted.resolutionReason).toBe('COMPLETED');

  });

  it('C1: transfer from WAITING is a conflicting transfer and needs a current handoff', async () => {
    await work.commission(comm, { id: 'c1-waitxfer2', operationId: 'op-c1w2-commission', objective: 'Waiting transfer two', priority: 'normal' });
    let detail = await work.get(comm, 'c1-waitxfer2');
    await work.claim(maker, { workId: 'c1-waitxfer2', operationId: 'op-c1w2-claim', expectedRevision: detail.work.revision });
    detail = await work.get(comm, 'c1-waitxfer2');
    await work.transition(maker, { workId: 'c1-waitxfer2', operationId: 'op-c1w2-wait', expectedRevision: detail.work.revision, toState: 'WAITING' });
    detail = await work.get(comm, 'c1-waitxfer2');
    await expect(work.transfer(comm, { workId: 'c1-waitxfer2', operationId: 'op-c1w2-xfer', expectedRevision: detail.work.revision, toExecutorId: 'peer', note: 'Take waiting work' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await work.recordStopHandoff(maker, { workId: 'c1-waitxfer2', operationId: 'op-c1w2-hand', expectedRevision: detail.work.revision, note: 'Waiting handoff' });
    detail = await work.get(comm, 'c1-waitxfer2');
    const moved = await work.transfer(comm, { workId: 'c1-waitxfer2', operationId: 'op-c1w2-xfer2', expectedRevision: detail.work.revision, toExecutorId: 'peer', note: 'Take waiting work' });
    expect(moved.state).toBe('WAITING');
    const afterTransfer = await work.get(comm, 'c1-waitxfer2');
    expect(afterTransfer.work.executorId).toBe('peer');
  });

  it('C1: active work with no stop cannot close without a proactive handoff; idle work stays exempt', async () => {
    await work.commission(comm, { id: 'c1-nostop', operationId: 'op-c1n-commission', objective: 'Never stopped', priority: 'normal' });
    let detail = await work.get(comm, 'c1-nostop');
    await work.claim(maker, { workId: 'c1-nostop', operationId: 'op-c1n-claim', expectedRevision: detail.work.revision });
    detail = await work.get(comm, 'c1-nostop');
    await work.transition(maker, { workId: 'c1-nostop', operationId: 'op-c1n-start', expectedRevision: detail.work.revision, toState: 'IN_PROGRESS' });
    detail = await work.get(comm, 'c1-nostop');
    await expect(
      work.resolve(comm, { workId: 'c1-nostop', operationId: 'op-c1n-resolve-early', expectedRevision: detail.work.revision, reason: 'CANCELLED' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // A proactive handoff (no stop was ever requested) satisfies the gate.
    await work.recordStopHandoff(maker, { workId: 'c1-nostop', operationId: 'op-c1n-hand', expectedRevision: detail.work.revision, note: 'Wrapping up cleanly' });
    detail = await work.get(comm, 'c1-nostop');
    const closed = await work.resolve(comm, { workId: 'c1-nostop', operationId: 'op-c1n-resolve', expectedRevision: detail.work.revision, reason: 'OBSOLETE' });
    expect(closed.state).toBe('RESOLVED');

    // Unclaimed work and verified no-start work need no handoff.
    await work.commission(comm, { id: 'c1-idle2', operationId: 'op-c1i2-commission', objective: 'Idle', priority: 'low' });
    detail = await work.get(comm, 'c1-idle2');
    const idleClosed = await work.resolve(comm, { workId: 'c1-idle2', operationId: 'op-c1i2-resolve', expectedRevision: detail.work.revision, reason: 'CANCELLED' });
    expect(idleClosed.state).toBe('RESOLVED');

    await work.commission(comm, { id: 'c1-nostart', operationId: 'op-c1ns-commission', objective: 'Claimed but never started', priority: 'normal' });
    detail = await work.get(comm, 'c1-nostart');
    await work.claim(maker, { workId: 'c1-nostart', operationId: 'op-c1ns-claim', expectedRevision: detail.work.revision });
    detail = await work.get(comm, 'c1-nostart');
    const moved = await work.transfer(comm, { workId: 'c1-nostart', operationId: 'op-c1ns-transfer', expectedRevision: detail.work.revision, toExecutorId: 'peer', note: 'Reassign before start' });
    expect(moved.state).toBe('CLAIMED');
    const ready = await work.get(comm, 'c1-nostart');
    const noStartClosed = await work.resolve(comm, { workId: 'c1-nostart', operationId: 'op-c1ns-resolve', expectedRevision: ready.work.revision, reason: 'CANCELLED' });
    expect(noStartClosed.state).toBe('RESOLVED');
  });

  it('C1: superseding active work needs a current handoff; the replacement is never orphaned', async () => {
    await work.commission(comm, { id: 'c1-sup-old', operationId: 'op-c1sup-commission', objective: 'Old direction', priority: 'normal' });
    let detail = await work.get(comm, 'c1-sup-old');
    await work.claim(maker, { workId: 'c1-sup-old', operationId: 'op-c1sup-claim', expectedRevision: detail.work.revision });
    detail = await work.get(comm, 'c1-sup-old');
    await work.transition(maker, { workId: 'c1-sup-old', operationId: 'op-c1sup-start', expectedRevision: detail.work.revision, toState: 'IN_PROGRESS' });

    detail = await work.get(comm, 'c1-sup-old');
    await expect(
      work.commission(comm, {
        id: 'c1-sup-new',
        operationId: 'op-c1sup-new-commission',
        objective: 'New direction',
        priority: 'normal',
        supersedesWorkId: 'c1-sup-old',
        supersedesExpectedRevision: detail.work.revision,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // The failed supersession created no replacement: nothing orphaned.
    await expect(work.get(comm, 'c1-sup-new')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await work.recordStopHandoff(maker, { workId: 'c1-sup-old', operationId: 'op-c1sup-hand', expectedRevision: detail.work.revision, note: 'Old work parked' });
    detail = await work.get(comm, 'c1-sup-old');
    const replacement = await work.commission(comm, {
      id: 'c1-sup-new',
      operationId: 'op-c1sup-new-commission',
      objective: 'New direction',
      priority: 'normal',
      supersedesWorkId: 'c1-sup-old',
      supersedesExpectedRevision: detail.work.revision,
    });
    expect(replacement.work.replacesWorkId).toBe('c1-sup-old');
    const old = await work.get(comm, 'c1-sup-old');
    expect(old.work.state).toBe('RESOLVED');
    expect(old.work.resolutionReason).toBe('SUPERSEDED');
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

  it('migration 0004 backfills episode markers for legacy stop and execution state', async () => {
    const legacy = new SqliteAdapter(':memory:');
    await legacy.exec(readFileSync('src/db/migrations/0001_initial_schema.sql', 'utf8'));
    await legacy.exec(readFileSync('src/db/migrations/0002_work_records.sql', 'utf8'));
    await legacy.exec(readFileSync('src/db/migrations/0003_work_event_receipts.sql', 'utf8'));
    const seed = async (id: string, state: string, stopRequested: boolean, handoff: boolean, executor: string | null) => {
      await legacy.execute(
        `INSERT INTO work_items (project_id, id, state, priority, objective, commissioner_id, commissioner_role, executor_id, stop_requested_at, stop_requested_by, stop_handoff_at, created_at, updated_at)
         VALUES ('p', ?, ?, 'normal', 'legacy', 'comm', 'agent', ?, ?, ?, ?, 1, 1)`,
        [id, state, executor, stopRequested ? 1 : null, stopRequested ? 'comm' : null, handoff ? 2 : null]
      );
    };
    await seed('w-pending', 'IN_PROGRESS', true, false, 'maker');
    await seed('w-handed', 'WAITING', true, true, 'maker');
    await seed('w-idle', 'UNCLAIMED', false, false, null);
    await seed('w-done', 'RESOLVED', true, true, 'maker');
    await legacy.exec(readFileSync('src/db/migrations/0004_work_episodes.sql', 'utf8'));

    const row = async (id: string) =>
      await legacy.queryFirst<any>(`SELECT exec_episode, stop_seq, stop_open, handoff_episode, handoff_stop_seq, handoff_by, exec_started_episode FROM work_items WHERE id = ?`, [id]);
    expect(await row('w-pending')).toMatchObject({ exec_episode: 0, stop_seq: 1, stop_open: 1, handoff_episode: null, exec_started_episode: 0 });
    // Live rows never inherit a handoff binding: the migration cannot see
    // whether execution resumed after the handoff, so they must earn a fresh
    // one. RESOLVED rows keep theirs informationally (the gate never applies).
    expect(await row('w-handed')).toMatchObject({ exec_episode: 0, stop_seq: 1, stop_open: 0, handoff_episode: null, handoff_stop_seq: null, handoff_by: null });
    expect(await row('w-done')).toMatchObject({ handoff_episode: 0, handoff_stop_seq: 1, handoff_by: 'maker' });
    expect(await row('w-idle')).toMatchObject({ exec_episode: 0, stop_seq: 0, stop_open: 0, handoff_episode: null, exec_started_episode: null });

    // The backfilled pending stop still gates closure under the new code.
    const targetWork = new WorkService(legacy);
    const targetAuth = new AuthService(legacy);
    await targetAuth.createProject('p', 'Legacy');
    const lead = { endpointId: 'comm', projectId: 'p', scopes: ['read', 'write'], role: 'agent' as const };
    const detail = await targetWork.get(lead, 'w-pending');
    await expect(
      targetWork.resolve(lead, { workId: 'w-pending', operationId: 'op-legacy-resolve', expectedRevision: detail.work.revision, reason: 'CANCELLED' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
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
