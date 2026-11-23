import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { createSwitchboardApp } from '../../src/http/app.js';
import { SwitchboardClient } from '../../src/client/switchboard-client.js';

describe('Channel Fan-Out and Privacy Isolation', () => {
  let db: SqliteAdapter;
  let authService: AuthService;
  let service: SwitchboardService;
  let clientA: SwitchboardClient;
  let clientB: SwitchboardClient;
  let clientC: SwitchboardClient;
  let clientD: SwitchboardClient;

  const projectId = 'proj-channels';
  const tokenA = 'tok-a';
  const tokenB = 'tok-b';
  const tokenC = 'tok-c';
  const tokenD = 'tok-d';

  beforeEach(async () => {
    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    authService = new AuthService(db);
    service = new SwitchboardService(db);

    await authService.createProject(projectId, 'Channel Test');
    await authService.registerEndpoint(projectId, 'member-a', 'Member A', 'agent');
    await authService.registerEndpoint(projectId, 'member-b', 'Member B', 'agent');
    await authService.registerEndpoint(projectId, 'member-c', 'Member C', 'agent');
    await authService.registerEndpoint(projectId, 'outsider-d', 'Outsider D', 'agent');

    await authService.issueToken(projectId, 'member-a', tokenA);
    await authService.issueToken(projectId, 'member-b', tokenB);
    await authService.issueToken(projectId, 'member-c', tokenC);
    await authService.issueToken(projectId, 'outsider-d', tokenD);

    const app = createSwitchboardApp({ authService, service });
    const customFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      return await app.fetch(new Request(u, init));
    }) as typeof fetch;

    clientA = new SwitchboardClient({
      baseUrl: 'http://localhost:3000',
      token: tokenA,
      endpointId: 'member-a',
      fetchFn: customFetch,
    });
    clientB = new SwitchboardClient({
      baseUrl: 'http://localhost:3000',
      token: tokenB,
      endpointId: 'member-b',
      fetchFn: customFetch,
    });
    clientC = new SwitchboardClient({
      baseUrl: 'http://localhost:3000',
      token: tokenC,
      endpointId: 'member-c',
      fetchFn: customFetch,
    });
    clientD = new SwitchboardClient({
      baseUrl: 'http://localhost:3000',
      token: tokenD,
      endpointId: 'outsider-d',
      fetchFn: customFetch,
    });
  });

  it('atomically resolves members at broadcast time and prevents retrospective leak to new members', async () => {
    const principalA = await authService.authenticate(`Bearer ${tokenA}`);
    const principalD = await authService.authenticate(`Bearer ${tokenD}`);

    // Create channel with initial members A, B, C
    await service.createChannel(principalA, 'chan-eng', 'Engineering', [
      'member-a',
      'member-b',
      'member-c',
    ]);

    // 1. Client A sends message to channel chan-eng
    clientA.queueMessage({
      id: 'chan-msg-001',
      recipientType: 'channel',
      recipientId: 'chan-eng',
      kind: 'announcement.v1',
      subject: 'Release scheduled at 14:00',
      payload: { releaseVersion: '0.1.0' },
    });
    const sendRes = await clientA.sync();
    expect(sendRes.storedReceipts).toHaveLength(1);
    expect(sendRes.storedReceipts[0]?.recipientCount).toBe(3); // A, B, C

    // 2. Members B and C sync and receive the channel message
    const resB = await clientB.sync();
    expect(resB.inboundMessages).toHaveLength(1);
    expect(resB.inboundMessages[0]?.id).toBe('chan-msg-001');

    const resC = await clientC.sync();
    expect(resC.inboundMessages).toHaveLength(1);
    expect(resC.inboundMessages[0]?.id).toBe('chan-msg-001');

    // 3. Outsider D syncs: receives 0 messages
    const resD = await clientD.sync();
    expect(resD.inboundMessages).toHaveLength(0);

    // 4. Outsider D attempts to fetch chan-msg-001 directly: access denied
    await expect(service.getMessage(principalD, 'chan-msg-001')).rejects.toThrowError(
      /Access to channel message denied/
    );

    // 5. Add D to the channel later
    await service.addChannelMember(principalA, 'chan-eng', 'outsider-d');

    // 6. D syncs again: still does NOT receive chan-msg-001 (no retrospective access to private history!)
    const resD2 = await clientD.sync();
    expect(resD2.inboundMessages).toHaveLength(0);

    // 7. A sends a second channel message
    clientA.queueMessage({
      id: 'chan-msg-002',
      recipientType: 'channel',
      recipientId: 'chan-eng',
      kind: 'announcement.v1',
      subject: 'Release completed',
      payload: { status: 'deployed' },
    });
    await clientA.sync();

    // Now D receives chan-msg-002
    const resD3 = await clientD.sync();
    expect(resD3.inboundMessages).toHaveLength(1);
    expect(resD3.inboundMessages[0]?.id).toBe('chan-msg-002');
  });
});
