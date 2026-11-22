import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { createSwitchboardApp } from '../../src/http/app.js';
import { SwitchboardClient } from '../../src/client/switchboard-client.js';

describe('Two-Client Durable Messaging Exchange', () => {
  let db: SqliteAdapter;
  let authService: AuthService;
  let service: SwitchboardService;
  let clientA: SwitchboardClient;
  let clientB: SwitchboardClient;

  const projectId = 'proj-workshop';
  const tokenA = 'token-agent-a-secret-xyz';
  const tokenB = 'token-agent-b-secret-abc';

  beforeEach(async () => {
    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    authService = new AuthService(db);
    service = new SwitchboardService(db);

    // Provision project and endpoints
    await authService.createProject(projectId, 'Workshop');
    await authService.registerEndpoint(projectId, 'agent-a', 'Agent Alpha', 'agent');
    await authService.registerEndpoint(projectId, 'agent-b', 'Agent Beta', 'agent');

    // Issue tokens
    await authService.issueToken(projectId, 'agent-a', tokenA, ['read', 'write']);
    await authService.issueToken(projectId, 'agent-b', tokenB, ['read', 'write']);

    const app = createSwitchboardApp({ authService, service });

    // In-memory fetch bridge for realistic HTTP testing without network port binding
    const customFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      const req = new Request(u, init);
      return await app.fetch(req);
    }) as typeof fetch;

    clientA = new SwitchboardClient({
      baseUrl: 'http://localhost:3000',
      token: tokenA,
      endpointId: 'agent-a',
      fetchFn: customFetch,
    });

    clientB = new SwitchboardClient({
      baseUrl: 'http://localhost:3000',
      token: tokenB,
      endpointId: 'agent-b',
      fetchFn: customFetch,
    });
  });

  it('completes durable round-trip message exchange, correlation, and acknowledgement', async () => {
    // 1. Agent A queues and sends a message to Agent B
    clientA.queueMessage({
      id: 'task-msg-001',
      recipientType: 'endpoint',
      recipientId: 'agent-b',
      kind: 'task.dispatch.v1',
      subject: 'Build authentication module',
      payload: { taskId: 'T-100', priority: 'high' },
      priority: 'urgent',
      threadId: 'th-auth-01',
    });

    const syncResA = await clientA.sync();
    expect(syncResA.storedReceipts).toHaveLength(1);
    expect(syncResA.storedReceipts[0]?.messageId).toBe('task-msg-001');
    expect(syncResA.storedReceipts[0]?.status).toBe('STORED');
    expect(clientA.getOutbox()).toHaveLength(0); // Pruned on confirmation

    // 2. Agent B syncs: receives the message
    const syncResB = await clientB.sync();
    expect(syncResB.inboundMessages).toHaveLength(1);
    const receivedMsg = syncResB.inboundMessages[0]!;
    expect(receivedMsg.id).toBe('task-msg-001');
    expect(receivedMsg.senderId).toBe('agent-a');
    expect(receivedMsg.deliverySequence).toBe(1);
    expect(receivedMsg.deliveryStatus).toBe('STORED');
    expect(receivedMsg.subject).toBe('Build authentication module');
    expect((receivedMsg.payload as any).taskId).toBe('T-100');

    // 3. Agent B replies to Agent A and acknowledges the incoming message
    clientB.queueAck({
      messageId: 'task-msg-001',
      senderId: 'agent-a',
      note: 'Accepted task assignment',
    });

    clientB.queueMessage({
      id: 'reply-msg-002',
      recipientType: 'endpoint',
      recipientId: 'agent-a',
      kind: 'task.accept.v1',
      subject: 'Re: Build authentication module',
      payload: { taskId: 'T-100', etaMinutes: 45 },
      priority: 'normal',
      threadId: 'th-auth-01',
      replyToId: 'task-msg-001',
    });

    const syncResB2 = await clientB.sync();
    expect(syncResB2.storedReceipts).toHaveLength(1);
    expect(syncResB2.storedReceipts[0]?.messageId).toBe('reply-msg-002');
    expect(syncResB2.acknowledgedReceipts).toHaveLength(1);
    expect(syncResB2.acknowledgedReceipts[0]?.messageId).toBe('task-msg-001');

    // 4. Agent A syncs: receives Agent B's reply
    const syncResA2 = await clientA.sync();
    expect(syncResA2.inboundMessages).toHaveLength(1);
    const replyMsg = syncResA2.inboundMessages[0]!;
    expect(replyMsg.id).toBe('reply-msg-002');
    expect(replyMsg.senderId).toBe('agent-b');
    expect(replyMsg.replyToId).toBe('task-msg-001');
    expect(replyMsg.threadId).toBe('th-auth-01');

    // 5. Verify thread retrieval returns full correlated conversation in chronological order
    const principalA = await authService.authenticate(`Bearer ${tokenA}`);
    const thread = await service.getThread(principalA, 'th-auth-01');
    expect(thread).toHaveLength(2);
    expect(thread[0]?.id).toBe('task-msg-001');
    expect(thread[1]?.id).toBe('reply-msg-002');

    // 6. Verify inbox shows acknowledged delivery is no longer unacknowledged
    const inboxB = await clientB.sync();
    // No new inbound messages
    expect(inboxB.inboundMessages).toHaveLength(0);

    const inboxCheck = await service.getInbox(principalA);
    // Agent A still hasn't acked reply-msg-002, so total unacked is 1
    expect(inboxCheck.total).toBe(1);
    expect(inboxCheck.deliveries[0]?.id).toBe('reply-msg-002');
  });
});
