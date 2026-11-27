import { describe, it, expect } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { D1Adapter } from '../../src/db/d1-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { WorkService } from '../../src/work/work-service.js';
import { createSimulatedD1 } from '../support/simulated-d1.js';
import type { DatabaseSession } from '../../src/db/database.js';

/**
 * SWB-SWEEP-001 — the same work contract must hold on both storage profiles.
 * Nothing here uses Node-only shortcuts on the hosted path.
 */
describe.each([
  { profile: 'Self-Hosted (Node.js + SQLite)', createSession: () => new SqliteAdapter(':memory:') as DatabaseSession },
  { profile: 'Hosted (Cloudflare D1 adapter)', createSession: () => new D1Adapter(createSimulatedD1()) as DatabaseSession },
])('Work lifecycle portability: $profile', ({ createSession }) => {
  const projectId = 'proj-work-portable';

  async function bootstrap() {
    const db = createSession();
    await initializeSchema(db);
    const auth = new AuthService(db);
    const work = new WorkService(db);
    await auth.createProject(projectId, 'Portable Work');
    await auth.registerEndpoint(projectId, 'lead', 'Lead', 'admin');
    await auth.registerEndpoint(projectId, 'maker', 'Maker', 'agent');
    await auth.issueToken(projectId, 'lead', 'tok-lead');
    await auth.issueToken(projectId, 'maker', 'tok-maker');
    return {
      db,
      work,
      lead: await auth.authenticate('Bearer tok-lead'),
      maker: await auth.authenticate('Bearer tok-maker'),
    };
  }

  it('runs commission, claim, submit, accept, archive and reopen identically', async () => {
    const { work, lead, maker } = await bootstrap();

    const commissioned = await work.commission(lead, {
      id: 'portable-1',
      operationId: 'op-c-1',
      objective: 'Portable lifecycle slice',
      priority: 'normal',
      scopeRefs: ['src/work'],
      acceptanceCriteria: ['both profiles pass'],
    });
    expect(commissioned.work.state).toBe('UNCLAIMED');
    expect(commissioned.receipt.eventSeq).toBe(1);

    const claimed = await work.claim(maker, { workId: 'portable-1', operationId: 'op-claim-1', expectedRevision: 1 });
    expect(claimed.revision).toBe(2);
    expect(claimed.state).toBe('CLAIMED');

    const started = await work.transition(maker, {
      workId: 'portable-1',
      operationId: 'op-start-1',
      expectedRevision: 2,
      toState: 'IN_PROGRESS',
    });
    expect(started.revision).toBe(3);

    const submitted = await work.transition(maker, {
      workId: 'portable-1',
      operationId: 'op-submit-1',
      expectedRevision: 3,
      toState: 'SUBMITTED',
    });
    expect(submitted.revision).toBe(4);

    const accepted = await work.resolve(lead, {
      workId: 'portable-1',
      operationId: 'op-accept-1',
      expectedRevision: 4,
      reason: 'COMPLETED',
      evidenceRefs: ['tests/integration/work-lifecycle.test.ts'],
    });
    expect(accepted.state).toBe('RESOLVED');
    expect(accepted.resolutionReason).toBe('COMPLETED');

    const archived = await work.archive(lead, {
      workId: 'portable-1',
      operationId: 'op-archive-1',
      expectedRevision: 5,
    });
    expect(archived.revision).toBe(6);

    const detail = await work.get(lead, 'portable-1');
    expect(detail.work.archivedAt).not.toBeNull();
    expect(detail.events.map((event) => event.eventType)).toEqual([
      'COMMISSIONED',
      'CLAIMED',
      'STATE_CHANGED',
      'STATE_CHANGED',
      'RESOLVED',
      'ARCHIVED',
    ]);

    const reopened = await work.reopen(lead, {
      workId: 'portable-1',
      operationId: 'op-reopen-1',
      expectedRevision: 6,
      reason: 'Acceptance evidence was wrong',
    });
    expect(reopened.state).toBe('CLAIMED');
    expect(reopened.revision).toBe(7);
  });

  it('returns the original receipt for a replayed operation and refuses stale revisions', async () => {
    const { work, lead, maker } = await bootstrap();
    await work.commission(lead, {
      id: 'portable-2',
      operationId: 'op-c-2',
      objective: 'Replay and stale revision',
      priority: 'normal',
    });
    await work.claim(maker, { workId: 'portable-2', operationId: 'op-claim-2', expectedRevision: 1 });

    const replayed = await work.claim(maker, { workId: 'portable-2', operationId: 'op-claim-2', expectedRevision: 1 });
    expect(replayed.isReplay).toBe(true);
    expect(replayed.revision).toBe(2);

    await expect(
      work.transition(maker, {
        workId: 'portable-2',
        operationId: 'op-stale-2',
        expectedRevision: 1,
        toState: 'IN_PROGRESS',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const after = await work.get(lead, 'portable-2');
    expect(after.work.revision).toBe(2);
    expect(after.work.state).toBe('CLAIMED');
    expect(after.events).toHaveLength(2);
  });

  it('rejects an unauthorised principal before any write on both profiles', async () => {
    const { work, lead, maker } = await bootstrap();
    await work.commission(lead, {
      id: 'portable-3',
      operationId: 'op-c-3',
      objective: 'Authority boundary',
      priority: 'normal',
    });

    await expect(
      work.resolve(maker, {
        workId: 'portable-3',
        operationId: 'op-forged-3',
        expectedRevision: 1,
        reason: 'CANCELLED',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const detail = await work.get(lead, 'portable-3');
    expect(detail.work.state).toBe('UNCLAIMED');
    expect(detail.events).toHaveLength(1);
  });

  it('commits a replacement and disposition together, or neither', async () => {
    const { work, lead } = await bootstrap();
    await work.commission(lead, {
      id: 'portable-old',
      operationId: 'op-c-old',
      objective: 'Old direction',
      priority: 'normal',
      scopeRefs: ['src/sync'],
    });

    const replacement = await work.commission(lead, {
      id: 'portable-new',
      operationId: 'op-c-new',
      objective: 'New direction',
      priority: 'normal',
      scopeRefs: ['src/sync'],
      supersedesWorkId: 'portable-old',
      supersedesExpectedRevision: 1,
    });
    expect(replacement.work.replacesWorkId).toBe('portable-old');

    const old = await work.get(lead, 'portable-old');
    expect(old.work.state).toBe('RESOLVED');
    expect(old.work.resolutionReason).toBe('SUPERSEDED');
    expect(old.work.supersededByWorkId).toBe('portable-new');

    // A stale supersession revision leaves both records untouched.
    await work.commission(lead, {
      id: 'portable-old-2',
      operationId: 'op-c-old-2',
      objective: 'Second old direction',
      priority: 'normal',
    });
    await expect(
      work.commission(lead, {
        id: 'portable-new-2',
        operationId: 'op-c-new-2',
        objective: 'Second new direction',
        priority: 'normal',
        supersedesWorkId: 'portable-old-2',
        supersedesExpectedRevision: 9,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(work.get(lead, 'portable-new-2')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const stillOpen = await work.get(lead, 'portable-old-2');
    expect(stillOpen.work.state).toBe('UNCLAIMED');
  });
});
