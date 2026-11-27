import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { WorkService } from '../../src/work/work-service.js';
import type { DatabaseSession } from '../../src/db/database.js';
import type { AuthPrincipal } from '../../src/core/types.js';

/**
 * SWB-SWEEP-001 adversarial slice.
 *
 * Hostile cases: replay, forged or stale authority, cross-project probing,
 * orphaned supersession, and the cost of the read paths a board would use.
 */

interface QueryStats {
  queries: number;
  rowsReturned: number;
  writes: number;
}

/** Counts real database work without changing semantics. */
function countingDb(inner: DatabaseSession, stats: QueryStats): DatabaseSession {
  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      stats.queries++;
      const rows = await inner.query<T>(sql, params);
      stats.rowsReturned += rows.length;
      return rows;
    },
    async queryFirst<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      stats.queries++;
      const row = await inner.queryFirst<T>(sql, params);
      if (row) stats.rowsReturned += 1;
      return row;
    },
    async execute(sql: string, params: unknown[] = []) {
      stats.writes++;
      return await inner.execute(sql, params);
    },
    async exec(sql: string) {
      return await inner.exec(sql);
    },
    async transaction<T>(fn: (tx: DatabaseSession) => Promise<T>) {
      return await inner.transaction((tx) => fn(countingDb(tx, stats)));
    },
    close() {
      void inner.close?.();
    },
  };
}

describe('Work lifecycle adversarial checks (SWB-SWEEP-001)', () => {
  const projectId = 'proj-terror';
  let db: SqliteAdapter;
  let auth: AuthService;
  let service: SwitchboardService;
  let work: WorkService;
  let stats: QueryStats;
  let lead: AuthPrincipal;
  let maker: AuthPrincipal;
  let peer: AuthPrincipal;
  let stranger: AuthPrincipal;

  beforeEach(async () => {
    stats = { queries: 0, rowsReturned: 0, writes: 0 };
    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    auth = new AuthService(db);
    service = new SwitchboardService(db);
    work = new WorkService(countingDb(db, stats));

    await auth.createProject(projectId, 'Terror Project');
    await auth.registerEndpoint(projectId, 'lead', 'Lead', 'admin');
    await auth.registerEndpoint(projectId, 'maker', 'Maker', 'agent');
    await auth.registerEndpoint(projectId, 'peer', 'Peer', 'agent');
    await auth.issueToken(projectId, 'lead', 'tok-lead');
    await auth.issueToken(projectId, 'maker', 'tok-maker');
    await auth.issueToken(projectId, 'peer', 'tok-peer');

    await auth.createProject('proj-outsider', 'Outsider');
    await auth.registerEndpoint('proj-outsider', 'outsider', 'Outsider', 'admin');
    await auth.issueToken('proj-outsider', 'outsider', 'tok-outsider');

    lead = await auth.authenticate('Bearer tok-lead');
    maker = await auth.authenticate('Bearer tok-maker');
    peer = await auth.authenticate('Bearer tok-peer');
    stranger = await auth.authenticate('Bearer tok-outsider');
  });

  async function commission(id: string, extra: Record<string, unknown> = {}) {
    return await work.commission(lead, {
      id,
      operationId: `op-c-${id}`,
      objective: `Objective for ${id}`,
      priority: 'normal',
      ...extra,
    });
  }

  it('never reverses a disposition when a supersession is replayed', async () => {
    await commission('old-1');
    const first = await work.commission(lead, {
      id: 'new-1',
      operationId: 'op-supersede-once',
      objective: 'Replacement',
      priority: 'normal',
      supersedesWorkId: 'old-1',
      supersedesExpectedRevision: 1,
    });
    expect(first.receipt.isReplay).toBe(false);

    const replay = await work.commission(lead, {
      id: 'new-1',
      operationId: 'op-supersede-once',
      objective: 'Replacement',
      priority: 'normal',
      supersedesWorkId: 'old-1',
      supersedesExpectedRevision: 1,
    });
    expect(replay.receipt.isReplay).toBe(true);
    expect(replay.work.id).toBe('new-1');

    const old = await work.get(lead, 'old-1');
    expect(old.work.state).toBe('RESOLVED');
    expect(old.work.resolutionReason).toBe('SUPERSEDED');
    expect(old.events.filter((event) => event.eventType === 'RESOLVED')).toHaveLength(1);

    // A different operation id trying the same supersession is a conflict, not a second close.
    await expect(
      work.commission(lead, {
        id: 'new-1',
        operationId: 'op-supersede-again',
        objective: 'Replacement',
        priority: 'normal',
        supersedesWorkId: 'old-1',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await work.get(lead, 'old-1')).events).toHaveLength(2);
  });

  it('cannot orphan a closure on a missing or already-resolved replacement', async () => {
    await commission('orphan-target');
    await expect(
      work.supersede(lead, {
        workId: 'orphan-target',
        operationId: 'op-supersede-ghost',
        expectedRevision: 1,
        replacementWorkId: 'does-not-exist',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const stillOpen = await work.get(lead, 'orphan-target');
    expect(stillOpen.work.state).toBe('UNCLAIMED');

    await expect(
      work.supersede(lead, {
        workId: 'orphan-target',
        operationId: 'op-supersede-self',
        expectedRevision: 1,
        replacementWorkId: 'orphan-target',
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses a forged closure attempt by a peer with the write scope', async () => {
    await commission('guarded');
    await expect(
      work.resolve(peer, {
        workId: 'guarded',
        operationId: 'op-peer-close',
        expectedRevision: 1,
        reason: 'COMPLETED',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      work.archive(peer, {
        workId: 'guarded',
        operationId: 'op-peer-archive',
        expectedRevision: 1,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const detail = await work.get(lead, 'guarded');
    expect(detail.work.state).toBe('UNCLAIMED');
    expect(detail.events).toHaveLength(1);
  });

  it('keeps identical work ids isolated per project', async () => {
    await commission('shared-id');
    await work.commission(stranger, {
      id: 'shared-id',
      operationId: 'op-other-project',
      objective: 'A different project with the same id',
      priority: 'normal',
    });

    const here = await work.get(lead, 'shared-id');
    const there = await work.get(stranger, 'shared-id');
    expect(here.work.projectId).toBe(projectId);
    expect(there.work.projectId).toBe('proj-outsider');
    expect(here.events).toHaveLength(1);
    expect(there.events).toHaveLength(1);

    // A work id that exists only in the other project is invisible here.
    await expect(
      work.resolve(stranger, {
        workId: 'guarded-only-here',
        operationId: 'op-cross-close',
        expectedRevision: 1,
        reason: 'CANCELLED',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect((await work.get(lead, 'shared-id')).work.state).toBe('UNCLAIMED');
  });

  it('leaves delivery state untouched while work state changes', async () => {
    await service.sendMessage(lead, {
      id: 'msg-terror-1',
      recipientType: 'endpoint',
      recipientId: 'maker',
      kind: 'task.request.v1',
      subject: 'Urgent delivery must not be disturbed',
      payload: { detail: 'urgent' },
      priority: 'urgent',
    });
    await commission('with-delivery', { sourceMessageId: 'msg-terror-1' });

    const before = await service.getInbox(maker);
    expect(before.deliveries).toHaveLength(1);

    await work.claim(maker, { workId: 'with-delivery', operationId: 'op-claim-d', expectedRevision: 1 });
    await work.board(lead);
    await work.list(lead);

    const after = await service.getInbox(maker);
    expect(after.deliveries).toHaveLength(1);
    expect(after.deliveries[0]?.id).toBe('msg-terror-1');
    expect(after.deliveries[0]?.deliveryStatus).toBe('STORED');
  });

  it('answers a board for a large project with bounded queries and rows', async () => {
    const now = Date.now();
    await db.transaction(async (tx) => {
      for (let i = 0; i < 200; i++) {
        const state = i % 5 === 0 ? 'UNCLAIMED' : i % 5 === 1 ? 'IN_PROGRESS' : i % 5 === 2 ? 'WAITING' : i % 5 === 3 ? 'SUBMITTED' : 'RESOLVED';
        await tx.execute(
          `INSERT INTO work_items
             (project_id, id, state, resolution_reason, priority, objective, scope_refs, acceptance_criteria,
              evidence_refs, depends_on, commissioner_id, commissioner_role, executor_id, claimed_at,
              submitted_at, resolved_at, resolved_by, thread_id, source_message_id, replaces_work_id,
              superseded_by_work_id, stop_requested_at, stop_requested_by, stop_reason, stop_handoff_at,
              reconciliation_deferred, archived_at, revision, last_event_seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'lead', 'admin', ?, NULL, NULL, NULL, NULL,
                   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, 1, 1, ?, ?)`,
          [
            projectId,
            `bulk-${i}`,
            state,
            state === 'RESOLVED' ? 'COMPLETED' : null,
            'normal',
            `Bulk objective ${i}`,
            state === 'UNCLAIMED' ? null : 'maker',
            now - i * 1000,
            now - i * 1000,
          ]
        );
      }
      for (let i = 0; i < 120; i++) {
        await tx.execute(
          `INSERT INTO messages
             (id, sender_id, project_id, recipient_type, recipient_id, kind, subject, payload, payload_hash,
              envelope_hash, priority, thread_id, reply_to_id, evidence_refs, created_at)
           VALUES (?, 'lead', ?, 'endpoint', 'maker', 'bulk.v1', ?, '{}', 'h', 'e', 'normal', NULL, NULL, NULL, ?)`,
          [`bulk-msg-${i}`, projectId, `Bulk ${i}`, now]
        );
        await tx.execute(
          `INSERT INTO message_deliveries
             (project_id, message_id, sender_id, recipient_id, channel_id, sequence, status, delivered_at)
           VALUES (?, ?, 'lead', 'maker', NULL, ?, 'STORED', ?)`,
          [projectId, `bulk-msg-${i}`, i + 1, now]
        );
      }
    });

    const boardStart = stats.queries;
    const board = await work.board(lead);
    const boardQueries = stats.queries - boardStart;
    expect(board.counts.unclaimed).toBeGreaterThan(0);
    expect(boardQueries).toBeLessThanOrEqual(12);
    expect(board.unclaimed).toHaveLength(5);
    expect(board.deliveries.unacknowledged).toBe(120);

    const listStart = stats.queries;
    const page = await work.list(lead, { limit: 20 });
    expect(stats.queries - listStart).toBe(1);
    expect(page.items).toHaveLength(20);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toContain(':');

    const next = await work.list(lead, { limit: 20, cursor: page.nextCursor! });
    expect(next.items.map((item) => item.workId)).not.toEqual(page.items.map((item) => item.workId));
    expect(next.items).toHaveLength(20);
  });

  it('keeps terminal reasons distinguishable across archive and reopen', async () => {
    const reasons = ['COMPLETED', 'SUPERSEDED', 'OBSOLETE', 'CANCELLED', 'DUPLICATE'] as const;
    let index = 0;
    for (const reason of reasons) {
      const id = `reason-${index++}`;
      await commission(id);
      await work.claim(maker, { workId: id, operationId: `op-claim-${id}`, expectedRevision: 1 });
      await work.transition(maker, {
        workId: id,
        operationId: `op-submit-${id}`,
        expectedRevision: 2,
        toState: 'SUBMITTED',
      });
      if (reason === 'SUPERSEDED') {
        await commission(`${id}-replacement`);
        await work.resolve(lead, {
          workId: id,
          operationId: `op-resolve-${id}`,
          expectedRevision: 3,
          reason,
          replacementWorkId: `${id}-replacement`,
        });
      } else {
        await work.resolve(lead, {
          workId: id,
          operationId: `op-resolve-${id}`,
          expectedRevision: 3,
          reason,
        });
      }
      await work.archive(lead, { workId: id, operationId: `op-archive-${id}`, expectedRevision: 4 });
      const archived = await work.get(lead, id);
      expect(archived.work.resolutionReason).toBe(reason);
      expect(archived.events.at(-1)?.eventType).toBe('ARCHIVED');
    }

    const all = await work.list(lead, { includeArchived: true, limit: 50 });
    const archivedReasons = all.items
      .filter((item) => /^reason-\d+$/.test(item.workId))
      .map((item) => item.resolutionReason);
    expect(new Set(archivedReasons)).toEqual(new Set(reasons));
  });
});
