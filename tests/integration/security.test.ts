import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { createSwitchboardApp } from '../../src/http/app.js';
import { renderDashboardHtml } from '../../src/http/dashboard.js';
import { MAX_BODY_BYTES } from '../../src/core/schema.js';

describe('Security, Isolation, and Hardening', () => {
  let db: SqliteAdapter;
  let authService: AuthService;
  let service: SwitchboardService;
  let app: any;

  const projectA = 'proj-sec-alpha';
  const projectB = 'proj-sec-beta';
  const tokenA = 'tok-alpha-user';
  const tokenB = 'tok-beta-user';
  const tokenRevoked = 'tok-revoked-user';
  const tokenExpired = 'tok-expired-user';

  beforeEach(async () => {
    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    authService = new AuthService(db);
    service = new SwitchboardService(db);

    // Setup project A and B
    await authService.createProject(projectA, 'Project Alpha');
    await authService.createProject(projectB, 'Project Beta');

    await authService.registerEndpoint(projectA, 'user-a', 'User Alpha', 'agent');
    await authService.registerEndpoint(projectB, 'user-b', 'User Beta', 'agent');

    // Issue tokens
    await authService.issueToken(projectA, 'user-a', tokenA);
    await authService.issueToken(projectB, 'user-b', tokenB);

    // Revoked token
    await authService.issueToken(projectA, 'user-a', tokenRevoked);
    await authService.revokeToken(tokenRevoked);

    // Expired token (expired 1 hour ago)
    await authService.issueToken(projectA, 'user-a', tokenExpired, ['read'], -3600000);

    app = createSwitchboardApp({
      authService,
      service,
      rateLimitMaxPerMinute: 5, // low limit for testing throttled response
    });
  });

  it('rejects unauthenticated requests and invalid tokens', async () => {
    const resNoAuth = await app.fetch(new Request('http://localhost/api/v1/inbox'));
    expect(resNoAuth.status).toBe(401);

    const resBadToken = await app.fetch(
      new Request('http://localhost/api/v1/inbox', {
        headers: { Authorization: 'Bearer invalid-token-1234' },
      })
    );
    expect(resBadToken.status).toBe(401);
  });

  it('fails closed on revoked credentials', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/v1/inbox', {
        headers: { Authorization: `Bearer ${tokenRevoked}` },
      })
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toContain('revoked');
  });

  it('fails closed on expired credentials', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/v1/inbox', {
        headers: { Authorization: `Bearer ${tokenExpired}` },
      })
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toContain('expired');
  });

  it('enforces strict project boundary isolation', async () => {
    // User A in Project Alpha attempts to send message to User B in Project Beta
    const res = await app.fetch(
      new Request('http://localhost/api/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          id: 'cross-proj-01',
          recipientType: 'endpoint',
          recipientId: 'user-b', // exists in Beta, but NOT in Alpha
          kind: 'test.v1',
          subject: 'Cross Project Probe',
          payload: { text: 'hello' },
        }),
      })
    );

    // Must be rejected with 404 (not found in caller's project)
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.message).toContain('not found in project');
  });

  it('binds sender identity exclusively to authenticated principal and prevents sender spoofing', async () => {
    // Even if caller supplies senderId in payload or tries to impersonate admin,
    // Switchboard guarantees sender_id is derived solely from verified token
    const res = await app.fetch(
      new Request('http://localhost/api/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          id: 'forgery-probe',
          senderId: 'admin-spoofed',
          recipientType: 'endpoint',
          recipientId: 'user-a',
          kind: 'test.v1',
          subject: 'Impersonation Attempt',
          payload: { role: 'spoofed' },
        }),
      })
    );

    expect(res.status).toBe(201);
    const receipt = await res.json();
    expect(receipt.senderId).toBe('user-a'); // Server enforced authenticated principal!
  });

  it('rejects oversized message bodies exceeding 32 KiB', async () => {
    const oversize = 'a'.repeat(MAX_BODY_BYTES + 50);
    const res = await app.fetch(
      new Request('http://localhost/api/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          id: 'oversize-msg',
          recipientType: 'endpoint',
          recipientId: 'user-a',
          kind: 'large.v1',
          subject: 'Oversize',
          payload: { data: oversize },
        }),
      })
    );

    expect(res.status).toBe(400); // Validation failure on body size
  });

  it('enforces rate limits and returns 429 THROTTLED with Retry-After header', async () => {
    // configured limit is 5 req/min
    for (let i = 0; i < 5; i++) {
      const okRes = await app.fetch(
        new Request('http://localhost/api/v1/inbox', {
          headers: { Authorization: `Bearer ${tokenA}` },
        })
      );
      expect(okRes.status).toBe(200);
    }

    // 6th request triggers rate limiter
    const throttleRes = await app.fetch(
      new Request('http://localhost/api/v1/inbox', {
        headers: { Authorization: `Bearer ${tokenA}` },
      })
    );
    expect(throttleRes.status).toBe(429);
    expect(throttleRes.headers.get('Retry-After')).toBeTruthy();
    const body = await throttleRes.json();
    expect(body.error.code).toBe('THROTTLED');
  });

  it('escapes malicious script injection in Work Board HTML dashboard', () => {
    const maliciousBoard: any = {
      projectId: '<script>alert("pwned")</script>',
      serverTime: Date.now(),
      endpoints: [
        {
          endpointId: '<img src=x onerror=alert(1)>',
          projectId: 'p',
          state: 'available',
          description: '<script>hack()</script>',
          revision: 1,
          lastHeartbeatAt: Date.now(),
        },
      ],
      unackedCount: 0,
      recentMessages: [
        {
          id: 'msg-xss',
          senderId: 'attacker',
          recipientId: 'victim',
          priority: 'normal',
          subject: '<svg/onload=alert("xss")>',
          deliveryStatus: 'STORED',
          serverCreatedAt: Date.now(),
        },
      ],
      recentErrors: [],
    };

    const html = renderDashboardHtml(maliciousBoard, {});
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<svg/onload=alert("xss")>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;svg/onload=alert(&quot;xss&quot;)&gt;');
  });
});
