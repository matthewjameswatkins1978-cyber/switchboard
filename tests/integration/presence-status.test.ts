import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { createSwitchboardApp } from '../../src/http/app.js';
import { SwitchboardClient } from '../../src/client/switchboard-client.js';

describe('Presence, Scoped Status, and Optimistic Concurrency', () => {
  let db: SqliteAdapter;
  let authService: AuthService;
  let service: SwitchboardService;
  let clientA: SwitchboardClient;

  const projectId = 'proj-presence';
  const tokenA = 'tok-pres-a';

  beforeEach(async () => {
    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    authService = new AuthService(db);
    service = new SwitchboardService(db);

    await authService.createProject(projectId, 'Presence Test');
    await authService.registerEndpoint(projectId, 'worker-1', 'Worker 1', 'agent');
    await authService.issueToken(projectId, 'worker-1', tokenA);

    const app = createSwitchboardApp({ authService, service });
    const customFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      return await app.fetch(new Request(u, init));
    }) as typeof fetch;

    clientA = new SwitchboardClient({
      baseUrl: 'http://localhost:3000',
      token: tokenA,
      endpointId: 'worker-1',
      fetchFn: customFetch,
    });
  });

  it('updates latest status snapshot and handles optimistic revision concurrency', async () => {
    const principalA = await authService.authenticate(`Bearer ${tokenA}`);

    // Initial status
    const initial = await service.getStatus(principalA, 'worker-1');
    expect(initial.state).toBe('available');
    expect(initial.revision).toBe(1);

    // Update with matching expected revision
    const updated = await service.updateStatus(principalA, {
      state: 'busy',
      description: 'Running batch job #42',
      expectedRevision: 1,
    });
    expect(updated.state).toBe('busy');
    expect(updated.revision).toBe(2);
    expect(updated.description).toBe('Running batch job #42');

    // Attempt update with stale expected revision (1 instead of 2) -> CONFLICT
    await expect(
      service.updateStatus(principalA, {
        state: 'waiting',
        expectedRevision: 1,
      })
    ).rejects.toThrowError(/Revision conflict/);
  });

  it('coalesces fast polls, refreshes due heartbeats, and preserves explicit presence changes', async () => {
    const principalA = await authService.authenticate(`Bearer ${tokenA}`);
    await db.execute('UPDATE endpoint_status SET last_heartbeat_at = ? WHERE endpoint_id = ?', [Date.now() - 10_000, 'worker-1']);
    const beforeSync = await service.getStatus(principalA, 'worker-1');

    await clientA.sync();
    expect((await service.getStatus(principalA, 'worker-1')).lastHeartbeatAt).toBe(beforeSync.lastHeartbeatAt);
    const old = Date.now() - 61_000;
    await db.execute('UPDATE endpoint_status SET last_heartbeat_at = ? WHERE endpoint_id = ?', [old, 'worker-1']);
    await clientA.sync();
    const refreshed = await service.getStatus(principalA, 'worker-1');
    expect(refreshed.lastHeartbeatAt).toBeGreaterThan(old);
    expect(refreshed.revision).toBe(beforeSync.revision);
    await service.sync(principalA, { statusUpdate: { state: 'busy' } });
    const busy = await service.getStatus(principalA, 'worker-1');
    expect(busy.state).toBe('busy');
    expect(busy.revision).toBe(beforeSync.revision + 1);
  });

  it('ends fast waiting polling after two minutes without changing the status', async () => {
    const principalA = await authService.authenticate(`Bearer ${tokenA}`);
    expect((await service.sync(principalA, { statusUpdate: { state: 'waiting' } })).recommendedNextSyncMs).toBe(10_000);
    expect((await service.sync(principalA, {})).recommendedNextSyncMs).toBe(10_000);
    await db.execute('UPDATE endpoint_status SET updated_at = ? WHERE endpoint_id = ?', [Date.now() - 121_000, 'worker-1']);
    expect((await service.sync(principalA, {})).recommendedNextSyncMs).toBe(30_000);
    expect((await service.getStatus(principalA, 'worker-1')).state).toBe('waiting');
  });

  it('respects server throttling instead of overriding it while waiting', async () => {
    vi.useFakeTimers();
    let stop: (() => void) | undefined;
    try {
      clientA.setStatus({ state: 'waiting' });
      const sync = vi.spyOn(clientA, 'sync').mockResolvedValue({
        storedReceipts: [], acknowledgedReceipts: [], inboundMessages: [], errors: [],
        cursor: '', hasMore: false, serverTime: Date.now(), recommendedNextSyncMs: 90_000,
      });
      stop = clientA.startAutonomousSync();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(sync).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sync).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(35_000);
      expect(sync).toHaveBeenCalledTimes(2);
    } finally {
      stop?.();
      vi.useRealTimers();
    }
  });

  it('marks endpoint as stale after missed heartbeats', async () => {
    const principalA = await authService.authenticate(`Bearer ${tokenA}`);

    // Simulate old heartbeat: 4 minutes ago (> 180s threshold)
    const oldTime = Date.now() - 240000;
    await db.execute(
      `UPDATE endpoint_status SET last_heartbeat_at = ? WHERE endpoint_id = ?`,
      [oldTime, 'worker-1']
    );

    const endpoints = await service.listEndpoints(principalA);
    const ep = endpoints.find((e) => e.endpointId === 'worker-1');
    expect(ep?.isStale).toBe(true);
    expect(ep?.state).toBe('stale');
  });
});
