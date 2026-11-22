import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { createSwitchboardApp } from '../../src/http/app.js';
import { SwitchboardClient } from '../../src/client/switchboard-client.js';

describe('Batch Synchronization, Recovery, and Duplicate Suppression', () => {
  let db: SqliteAdapter;
  let authService: AuthService;
  let service: SwitchboardService;
  let clientA: SwitchboardClient;
  let clientB: SwitchboardClient;

  const projectId = 'proj-batch-test';
  const tokenA = 'tok-a';
  const tokenB = 'tok-b';

  beforeEach(async () => {
    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    authService = new AuthService(db);
    service = new SwitchboardService(db);

    await authService.createProject(projectId, 'Batch Test Project');
    await authService.registerEndpoint(projectId, 'client-a', 'Client Alpha', 'agent');
    await authService.registerEndpoint(projectId, 'client-b', 'Client Beta', 'agent');
    await authService.issueToken(projectId, 'client-a', tokenA);
    await authService.issueToken(projectId, 'client-b', tokenB);

    const app = createSwitchboardApp({ authService, service });
    const customFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      return await app.fetch(new Request(u, init));
    }) as typeof fetch;

    clientA = new SwitchboardClient({
      baseUrl: 'http://localhost:3000',
      token: tokenA,
      endpointId: 'client-a',
      fetchFn: customFetch,
    });

    clientB = new SwitchboardClient({
      baseUrl: 'http://localhost:3000',
      token: tokenB,
      endpointId: 'client-b',
      fetchFn: customFetch,
    });
  });

  it('batches multiple messages and confirms receipts atomically', async () => {
    for (let i = 1; i <= 5; i++) {
      clientA.queueMessage({
        id: `batch-msg-${i}`,
        recipientType: 'endpoint',
        recipientId: 'client-b',
        kind: 'batch.item.v1',
        subject: `Item ${i}`,
        payload: { index: i },
      });
    }

    expect(clientA.getOutbox()).toHaveLength(5);
    const syncResA = await clientA.sync();
    expect(syncResA.storedReceipts).toHaveLength(5);
    expect(clientA.getOutbox()).toHaveLength(0);

    // Client B syncs and receives all 5 in sequence
    const syncResB = await clientB.sync();
    expect(syncResB.inboundMessages).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(syncResB.inboundMessages[i]?.deliverySequence).toBe(i + 1);
      expect(syncResB.inboundMessages[i]?.id).toBe(`batch-msg-${i + 1}`);
    }
  });

  it('suppresses duplicate logical messages when client retries identical content', async () => {
    // Send once
    clientA.queueMessage({
      id: 'idemp-001',
      recipientType: 'endpoint',
      recipientId: 'client-b',
      kind: 'event.v1',
      subject: 'Unique Event',
      payload: { value: 42 },
    });
    const res1 = await clientA.sync();
    expect(res1.storedReceipts[0]?.isDuplicate).toBeFalsy();

    // Replay same message (e.g. simulated network loss where client did not record receipt)
    clientA.queueMessage({
      id: 'idemp-001',
      recipientType: 'endpoint',
      recipientId: 'client-b',
      kind: 'event.v1',
      subject: 'Unique Event',
      payload: { value: 42 },
    });
    const res2 = await clientA.sync();
    expect(res2.storedReceipts).toHaveLength(1);
    expect(res2.storedReceipts[0]?.messageId).toBe('idemp-001');
    expect(res2.storedReceipts[0]?.isDuplicate).toBe(true);

    // Verify recipient B only receives 1 delivery record, not 2
    const resB = await clientB.sync();
    expect(resB.inboundMessages).toHaveLength(1);
  });

  it('detects and rejects conflicting payloads reusing the same message ID', async () => {
    // Send initial message
    clientA.queueMessage({
      id: 'conflict-id',
      recipientType: 'endpoint',
      recipientId: 'client-b',
      kind: 'data.v1',
      subject: 'Version 1',
      payload: { version: 1 },
    });
    await clientA.sync();

    // Send differing payload with the same ID
    clientA.queueMessage({
      id: 'conflict-id',
      recipientType: 'endpoint',
      recipientId: 'client-b',
      kind: 'data.v1',
      subject: 'Version 2 with different payload',
      payload: { version: 2 },
    });

    const res = await clientA.sync();
    // Conflicting item generates structured error in sync response
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.id).toBe('conflict-id');
    expect(res.errors[0]?.code).toBe('CONFLICT');
  });

  it('handles partial batch errors cleanly without losing valid items', async () => {
    // Message 1 is valid, Message 2 targets non-existent endpoint, Message 3 is valid
    clientA.queueMessage({
      id: 'valid-1',
      recipientType: 'endpoint',
      recipientId: 'client-b',
      kind: 'test.v1',
      subject: 'Valid 1',
      payload: { ok: true },
    });
    clientA.queueMessage({
      id: 'invalid-nonexistent-dest',
      recipientType: 'endpoint',
      recipientId: 'nobody-here',
      kind: 'test.v1',
      subject: 'Invalid dest',
      payload: { ok: false },
    });
    clientA.queueMessage({
      id: 'valid-2',
      recipientType: 'endpoint',
      recipientId: 'client-b',
      kind: 'test.v1',
      subject: 'Valid 2',
      payload: { ok: true },
    });

    const res = await clientA.sync();
    expect(res.storedReceipts).toHaveLength(2);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.id).toBe('invalid-nonexistent-dest');
    expect(res.errors[0]?.code).toBe('NOT_FOUND');

    // Recipient B gets the 2 valid messages
    const resB = await clientB.sync();
    expect(resB.inboundMessages).toHaveLength(2);
    expect(resB.inboundMessages.map((m) => m.id)).toEqual(['valid-1', 'valid-2']);
  });

  it('re-delivers unacknowledged messages when client resets or loses cursor', async () => {
    clientA.queueMessage({
      id: 'persist-001',
      recipientType: 'endpoint',
      recipientId: 'client-b',
      kind: 'job.v1',
      subject: 'Persistent Job',
      payload: { jobId: 999 },
    });
    await clientA.sync();

    // Client B syncs and advances cursor
    const b1 = await clientB.sync();
    expect(b1.inboundMessages).toHaveLength(1);
    expect(clientB.getCursor()).toBeDefined();

    // Client B crashes / loses cursor without having acknowledged
    clientB.setCursor(''); // reset cursor

    // B syncs again without cursor: gets unacknowledged messages!
    const b2 = await clientB.sync();
    expect(b2.inboundMessages).toHaveLength(1);
    expect(b2.inboundMessages[0]?.id).toBe('persist-001');

    // Now B acknowledges
    clientB.queueAck({ messageId: 'persist-001', senderId: 'client-a' });
    await clientB.sync();

    // Next sync with cursor or reset cursor returns 0 unacknowledged messages
    clientB.setCursor('');
    const b3 = await clientB.sync();
    expect(b3.inboundMessages).toHaveLength(0);
  });
});
