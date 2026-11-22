import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { createSwitchboardApp } from '../../src/http/app.js';
import { checkReadiness } from '../../src/operations/control.js';
import { mountWebMcpRoutes } from '../../src/mcp/mcp-web-handler.js';

describe('Operational controls', () => {
  let db: SqliteAdapter;
  let authService: AuthService;
  let service: SwitchboardService;
  const headers = { Authorization: 'Bearer fixture-token' };
  beforeEach(async () => {
    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    authService = new AuthService(db);
    service = new SwitchboardService(db);
    await authService.registerEndpoint('fixture', 'endpoint', 'Fixture');
    await authService.issueToken('fixture', 'endpoint', 'fixture-token');
  });
  afterEach(() => db.close());

  it('reports liveness, negotiates protocol and preserves older clients', async () => {
    const app = createSwitchboardApp({ authService, service, readiness: () => checkReadiness(db) });
    const discovery = await app.request('/api/v1/discovery', { headers: { 'X-Switchboard-Protocol': '2' } });
    expect(discovery.status).toBe(200);
    expect((await discovery.json()).protocol.supported).toEqual([1]);
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/api/v1/inbox', { headers })).status).toBe(200);
    expect((await app.request('/api/v1/inbox', { headers: { ...headers, 'X-Switchboard-Protocol': '1' } })).status).toBe(200);
    const unsupported = await app.request('/api/v1/inbox', { headers: { ...headers, 'X-Switchboard-Protocol': '2' } });
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).error.code).toBe('UNSUPPORTED_PROTOCOL');
  });

  it('requires authentication for readiness and detects DB failure without exposing details', async () => {
    const app = createSwitchboardApp({ authService, service, readiness: () => checkReadiness(db) });
    expect((await app.request('/api/v1/readiness')).status).toBe(401);
    expect((await app.request('/api/v1/readiness', { headers })).status).toBe(200);
    const broken = createSwitchboardApp({ authService, service, readiness: async () => { throw Error('SECRET'); } });
    const res = await broken.request('/api/v1/readiness', { headers });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unavailable', ready: false });
  });

  it('brake rejects REST and MCP before DB/auth work, and resumes on restart', async () => {
    const authenticate = vi.spyOn(authService, 'authenticate');
    const app = createSwitchboardApp({ authService, service, paused: true });
    mountWebMcpRoutes(app, { authService, service });
    for (const path of ['/api/v1/sync', '/mcp', '/api/v1/readiness', '/board']) {
      const res = await app.request(path, { headers });
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('120');
    }
    expect(authenticate).not.toHaveBeenCalled();
    expect((await (await app.request('/health')).json()).mode).toBe('paused');
    expect((await app.request('/api/v1/discovery')).status).toBe(200);
    const resumed = createSwitchboardApp({ authService, service });
    expect((await resumed.request('/api/v1/inbox', { headers })).status).toBe(200);
  });
});
