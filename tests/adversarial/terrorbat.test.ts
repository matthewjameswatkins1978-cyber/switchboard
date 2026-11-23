import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { D1Adapter, type D1DatabaseLike, type D1PreparedStatement } from '../../src/db/d1-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { createSwitchboardApp } from '../../src/http/app.js';
import {
  SwitchboardClient,
  FileClientStorage,
} from '../../src/client/switchboard-client.js';
import type { AuthPrincipal } from '../../src/core/types.js';

function createD1Double(): D1DatabaseLike {
  const memAdapter = new SqliteAdapter(':memory:');
  return {
    prepare(query: string): D1PreparedStatement {
      let bound: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...values: unknown[]) {
          bound = values;
          return stmt;
        },
        async first<T = unknown>(_col?: string): Promise<T | null> {
          return await memAdapter.queryFirst<T>(query, bound);
        },
        async all<T = unknown>(): Promise<{ results?: T[]; success: boolean }> {
          const results = await memAdapter.query<T>(query, bound);
          return { results, success: true };
        },
        async run(): Promise<{ success: boolean; meta?: any }> {
          const res = await memAdapter.execute(query, bound);
          return { success: true, meta: { changes: res.changes, last_row_id: res.lastInsertRowid } };
        },
      };
      return stmt;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      // In D1, batch is atomic: wrap in transaction
      return await memAdapter.transaction(async () => {
        const results: any[] = [];
        for (const s of statements) {
          results.push(await s.run());
        }
        return results;
      });
    },
    async exec(query: string) {
      await memAdapter.exec(query);
      return { count: 1, duration: 1 };
    },
  };
}

describe('Terrorbat Adversarial Qualification Campaign', () => {
  let tmpDir: string;
  let db: SqliteAdapter;
  let authService: AuthService;
  let service: SwitchboardService;

  const projectId = 'proj-terrorbat';
  const tokenA = 'tok-terror-a';
  const tokenB = 'tok-terror-b';
  const tokenC = 'tok-terror-c';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-terror-'));
    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    authService = new AuthService(db);
    service = new SwitchboardService(db);

    await authService.createProject(projectId, 'Terrorbat Adversarial Lab');
    await authService.registerEndpoint(projectId, 'bat-a', 'Bat Alpha', 'agent');
    await authService.registerEndpoint(projectId, 'bat-b', 'Bat Beta', 'agent');
    await authService.registerEndpoint(projectId, 'bat-c', 'Bat Gamma', 'agent');

    await authService.issueToken(projectId, 'bat-a', tokenA);
    await authService.issueToken(projectId, 'bat-b', tokenB);
    await authService.issueToken(projectId, 'bat-c', tokenC);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('Campaign 1: Interrupted transaction & partial channel fanout rolls back completely (SQLite and D1)', async () => {
    const principalA = await authService.authenticate(`Bearer ${tokenA}`);

    // Create channel with members bat-a, bat-b, bat-c
    await service.createChannel(principalA, 'chan-fault', 'Fault Channel', ['bat-a', 'bat-b', 'bat-c']);

    // Wrap db in a fault-injecting session that throws error on 2nd delivery insert
    let deliveryInsertCount = 0;
    const faultyDb: any = Object.create(db);
    faultyDb.transaction = async (fn: any) => {
      return await db.transaction(async (tx) => {
        const hookedTx: any = Object.create(tx);
        hookedTx.execute = async (sql: string, params: unknown[] = []) => {
          if (sql.includes('INSERT INTO message_deliveries')) {
            deliveryInsertCount++;
            if (deliveryInsertCount === 2) {
              throw new Error('FAULT_INJECTION: Network partition or storage crash during fanout!');
            }
          }
          return await tx.execute(sql, params);
        };
        return await fn(hookedTx);
      });
    };

    const faultService = new SwitchboardService(faultyDb);

    // Attempt channel send
    await expect(
      faultService.sendMessage(principalA, {
        id: 'msg-fanout-crash',
        recipientType: 'channel',
        recipientId: 'chan-fault',
        kind: 'alert.v1',
        subject: 'Crash test',
        payload: { danger: true },
      })
    ).rejects.toThrowError(/FAULT_INJECTION/);

    // Assert: ZERO stranded messages, ZERO orphan deliveries in database
    const msgCount = await db.queryFirst<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM messages WHERE id = ?`,
      ['msg-fanout-crash']
    );
    expect(msgCount?.cnt).toBe(0);

    const deliveryCount = await db.queryFirst<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM message_deliveries WHERE message_id = ?`,
      ['msg-fanout-crash']
    );
    expect(deliveryCount?.cnt).toBe(0);
  });

  it('Campaign 1b: Interrupted channel fanout in D1 rolls back cleanly without stranding messages', async () => {
    const d1Raw = createD1Double();
    const d1Adapter = new D1Adapter(d1Raw);
    await initializeSchema(d1Adapter);
    const d1Auth = new AuthService(d1Adapter);
    await d1Auth.createProject('proj-d1-fault', 'D1 Fault');
    await d1Auth.registerEndpoint('proj-d1-fault', 'd1-a', 'D1 A', 'agent');
    await d1Auth.registerEndpoint('proj-d1-fault', 'd1-b', 'D1 B', 'agent');
    await d1Auth.registerEndpoint('proj-d1-fault', 'd1-c', 'D1 C', 'agent');
    await d1Auth.issueToken('proj-d1-fault', 'd1-a', 'tok-d1-a');

    const pA = await d1Auth.authenticate('Bearer tok-d1-a');
    const d1Service = new SwitchboardService(d1Adapter);
    await d1Service.createChannel(pA, 'chan-d1', 'D1 Channel', ['d1-a', 'd1-b', 'd1-c']);

    // Inject fault into D1 adapter transaction
    let deliveryCount = 0;
    const faultD1Session: any = Object.create(d1Adapter);
    faultD1Session.transaction = async (fn: any) => {
      return await d1Adapter.transaction(async (tx) => {
        const hookedTx: any = Object.create(tx);
        hookedTx.execute = async (sql: string, params: unknown[] = []) => {
          if (sql.includes('INSERT INTO message_deliveries')) {
            deliveryCount++;
            if (deliveryCount === 2) {
              throw new Error('FAULT_INJECTION_D1: Simulated worker killed mid-fanout');
            }
          }
          return await tx.execute(sql, params);
        };
        return await fn(hookedTx);
      });
    };

    const d1FaultService = new SwitchboardService(faultD1Session);
    await expect(
      d1FaultService.sendMessage(pA, {
        id: 'd1-fanout-crash',
        recipientType: 'channel',
        recipientId: 'chan-d1',
        kind: 'test.v1',
        subject: 'D1 Crash',
        payload: { x: 1 },
      })
    ).rejects.toThrowError(/FAULT_INJECTION_D1/);

    // Verify D1 has 0 stranded messages or deliveries
    const msgs = await d1Adapter.queryFirst<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM messages WHERE id = ?`,
      ['d1-fanout-crash']
    );
    expect(msgs?.cnt).toBe(0);
  });

  it('Campaign 2: Overlapping concurrent transactions in SQLite: rollback of Task A does NOT roll back Task B', async () => {
    // Task A starts transaction, writes row, and will fail/rollback after a delay
    // Task B starts concurrently, writes row, and commits
    const taskAPromise = db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO projects (id, name, created_at) VALUES ('p-fail', 'Fail Proj', 100)`);
      // Simulating some async delay before failure
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('Task A deliberate rollback');
    }).catch((err) => err);

    // Task B runs concurrently
    const taskBPromise = db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO projects (id, name, created_at) VALUES ('p-success', 'Success Proj', 200)`);
      return 'B_COMMITTED';
    });

    const [resA, resB] = await Promise.all([taskAPromise, taskBPromise]);
    expect(resA.message).toBe('Task A deliberate rollback');
    expect(resB).toBe('B_COMMITTED');

    // Task A data must NOT exist
    const pA = await db.queryFirst(`SELECT id FROM projects WHERE id = 'p-fail'`);
    expect(pA).toBeNull();

    // Task B data MUST exist
    const pB = await db.queryFirst<{ id: string }>(`SELECT id FROM projects WHERE id = 'p-success'`);
    expect(pB?.id).toBe('p-success');
  });

  it('Campaign 3: Complete immutable envelope idempotency (same payload, differing recipient or subject is CONFLICT)', async () => {
    const principalA = await authService.authenticate(`Bearer ${tokenA}`);

    // Send original
    const r1 = await service.sendMessage(principalA, {
      id: 'idemp-env-1',
      recipientType: 'endpoint',
      recipientId: 'bat-b',
      kind: 'task.v1',
      subject: 'Subject Alpha',
      payload: { code: 123 },
    });
    expect(r1.status).toBe('STORED');

    // Replay with identical envelope -> duplicate suppressed (STORED, isDuplicate: true)
    const r2 = await service.sendMessage(principalA, {
      id: 'idemp-env-1',
      recipientType: 'endpoint',
      recipientId: 'bat-b',
      kind: 'task.v1',
      subject: 'Subject Alpha',
      payload: { code: 123 },
    });
    expect(r2.isDuplicate).toBe(true);

    // Replay with SAME payload but DIFFERENT subject -> must be CONFLICT (409)
    await expect(
      service.sendMessage(principalA, {
        id: 'idemp-env-1',
        recipientType: 'endpoint',
        recipientId: 'bat-b',
        kind: 'task.v1',
        subject: 'Differing Subject!',
        payload: { code: 123 },
      })
    ).rejects.toThrowError(/already exists with differing envelope content/);

    // Replay with SAME payload but DIFFERENT recipient -> must be CONFLICT (409)
    await expect(
      service.sendMessage(principalA, {
        id: 'idemp-env-1',
        recipientType: 'endpoint',
        recipientId: 'bat-c', // Changed recipient!
        kind: 'task.v1',
        subject: 'Subject Alpha',
        payload: { code: 123 },
      })
    ).rejects.toThrowError(/already exists with differing envelope content/);
  });

  it('Campaign 4: Channel authorization attack and reply visibility attack', async () => {
    const principalA = await authService.authenticate(`Bearer ${tokenA}`);
    const principalC = await authService.authenticate(`Bearer ${tokenC}`);

    // Channel chan-private has members bat-a and bat-b (bat-c is NOT a member)
    await service.createChannel(principalA, 'chan-private', 'Private Channel', ['bat-a', 'bat-b']);

    // Bat C attempts to send to chan-private -> 403 FORBIDDEN
    await expect(
      service.sendMessage(principalC, {
        id: 'c-intruder-1',
        recipientType: 'channel',
        recipientId: 'chan-private',
        kind: 'chat.v1',
        subject: 'Intrusion',
        payload: { text: 'can you hear me?' },
      })
    ).rejects.toThrowError(/not a member of channel/);

    // Bat A sends private direct message to Bat B
    await service.sendMessage(principalA, {
      id: 'msg-private-ab',
      recipientType: 'endpoint',
      recipientId: 'bat-b',
      kind: 'secret.v1',
      subject: 'Between A and B',
      payload: { secret: '42' },
    });

    // Bat C attempts to reply to msg-private-ab without access -> 403 FORBIDDEN
    await expect(
      service.sendMessage(principalC, {
        id: 'c-reply-snoop',
        recipientType: 'endpoint',
        recipientId: 'bat-a',
        kind: 'chat.v1',
        subject: 'Re: Between A and B',
        payload: { text: 'I guessed your message ID' },
        replyToId: 'msg-private-ab',
      })
    ).rejects.toThrowError(/is not accessible to sender/);
  });

  it('Campaign 5: Unauthorized acknowledgement attack', async () => {
    const principalA = await authService.authenticate(`Bearer ${tokenA}`);
    const principalC = await authService.authenticate(`Bearer ${tokenC}`);

    // Bat A sends message to Bat B
    await service.sendMessage(principalA, {
      id: 'msg-for-b',
      recipientType: 'endpoint',
      recipientId: 'bat-b',
      kind: 'task.v1',
      subject: 'Only for B',
      payload: { task: 'clean' },
    });

    // Bat C attempts to acknowledge message intended for Bat B -> NOT_FOUND (unauthorized delivery)
    await expect(
      service.acknowledge(principalC, [{ messageId: 'msg-for-b', senderId: 'bat-a' }])
    ).rejects.toThrowError(/Delivery not found/);
  });

  it('Campaign 6: Process termination during sync & durable disk recovery', async () => {
    const app = createSwitchboardApp({ authService, service });
    const customFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      return await app.fetch(new Request(u, init));
    }) as typeof fetch;

    const stateFilePath = path.join(tmpDir, 'agent-a-state.json');
    const storage = new FileClientStorage(stateFilePath);

    // 1. Client 1 initializes with disk storage and queues 3 messages and an ack
    const clientA1 = new SwitchboardClient({
      baseUrl: 'http://localhost:3000',
      token: tokenA,
      endpointId: 'bat-a',
      fetchFn: customFetch,
      storage,
      autoFlushUrgent: false,
    });

    clientA1.queueMessage({
      id: 'durable-msg-1',
      recipientType: 'endpoint',
      recipientId: 'bat-b',
      kind: 'job.v1',
      subject: 'Survive restart 1',
      payload: { item: 1 },
    });
    clientA1.queueMessage({
      id: 'durable-msg-2',
      recipientType: 'endpoint',
      recipientId: 'bat-b',
      kind: 'job.v1',
      subject: 'Survive restart 2',
      payload: { item: 2 },
    });
    clientA1.queueAck({
      messageId: 'prior-msg-99',
      senderId: 'bat-b',
    });

    // State is written to disk
    expect(fs.existsSync(stateFilePath)).toBe(true);

    // 2. SIMULATE HARD PROCESS TERMINATION / CRASH (destroy clientA1 object without syncing)
    // Create completely fresh ClientA2 instance pointing to the same state file
    const clientA2 = new SwitchboardClient({
      baseUrl: 'http://localhost:3000',
      token: tokenA,
      endpointId: 'bat-a',
      fetchFn: customFetch,
      storage: new FileClientStorage(stateFilePath),
      autoFlushUrgent: false,
    });

    // Verify state was completely recovered from disk
    expect(clientA2.getOutbox()).toHaveLength(2);
    expect(clientA2.getOutbox()[0]?.message.id).toBe('durable-msg-1');
    expect(clientA2.getOutbox()[1]?.message.id).toBe('durable-msg-2');
    expect(clientA2.getPendingAcks()).toHaveLength(1);

    // 3. Client A2 syncs: messages are committed to server
    const syncRes = await clientA2.sync();
    expect(syncRes.storedReceipts).toHaveLength(2);
    expect(clientA2.getOutbox()).toHaveLength(0);

    // Verify recipient B receives both messages in exact sequence
    const clientB = new SwitchboardClient({
      baseUrl: 'http://localhost:3000',
      token: tokenB,
      endpointId: 'bat-b',
      fetchFn: customFetch,
    });
    const bRes = await clientB.sync();
    expect(bRes.inboundMessages).toHaveLength(2);
    expect(bRes.inboundMessages.map((m) => m.id)).toEqual(['durable-msg-1', 'durable-msg-2']);
  });

  it('Campaign 7: Lost response after commit (server commits, client crashes; replay is deduplicated)', async () => {
    const principalA = await authService.authenticate(`Bearer ${tokenA}`);
    const principalB = await authService.authenticate(`Bearer ${tokenB}`);

    // Client A sends message
    const msgInput = {
      id: 'lost-resp-001',
      recipientType: 'endpoint' as const,
      recipientId: 'bat-b',
      kind: 'trans.v1',
      subject: 'Lost network reply test',
      payload: { orderId: 888 },
    };

    const r1 = await service.sendMessage(principalA, msgInput);
    expect(r1.status).toBe('STORED');

    // Simulate client losing the response (timeout/reboot), client resends exact same message
    const r2 = await service.sendMessage(principalA, msgInput);
    expect(r2.status).toBe('STORED');
    expect(r2.isDuplicate).toBe(true);

    // Reconcile: exactly 1 message in messages table, exactly 1 delivery in deliveries table
    const msgs = await db.query(`SELECT id FROM messages WHERE project_id = ? AND id = ?`, [
      projectId,
      'lost-resp-001',
    ]);
    expect(msgs).toHaveLength(1);

    const dels = await db.query(`SELECT id FROM message_deliveries WHERE project_id = ? AND message_id = ?`, [
      projectId,
      'lost-resp-001',
    ]);
    expect(dels).toHaveLength(1);

    // Recipient B syncs: gets exactly 1 message
    const bSync = await service.sync(principalB, { limit: 10 });
    expect(bSync.inboundMessages).toHaveLength(1);
    expect(bSync.inboundMessages[0]?.id).toBe('lost-resp-001');
  });

  it('Campaign 8: Malformed cursors and boundary recovery', async () => {
    const principalB = await authService.authenticate(`Bearer ${tokenB}`);

    // Passing garbage or corrupted base64 string as cursor does not throw 500
    const syncGarbage = await service.sync(principalB, { sinceCursor: 'not-a-valid-cursor-garbage!@#$' });
    expect(syncGarbage.inboundMessages).toBeDefined();

    const syncInvalidBase64 = await service.sync(principalB, { sinceCursor: 'eyJzZXEiOiAic3RyaW5nIn0=' });
    expect(syncInvalidBase64.inboundMessages).toBeDefined();
  });
});
