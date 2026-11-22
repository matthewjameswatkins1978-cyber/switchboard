import { describe, it, expect, beforeEach } from 'vitest';
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

  it('piggybacks heartbeat automatically on sync requests', async () => {
    const principalA = await authService.authenticate(`Bearer ${tokenA}`);
    const beforeSync = await service.getStatus(principalA, 'worker-1');

    // Artificial delay to observe monotonic heartbeat advance
    await new Promise((r) => setTimeout(r, 20));

    await clientA.sync();

    const afterSync = await service.getStatus(principalA, 'worker-1');
    expect(afterSync.lastHeartbeatAt).toBeGreaterThan(beforeSync.lastHeartbeatAt);
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
