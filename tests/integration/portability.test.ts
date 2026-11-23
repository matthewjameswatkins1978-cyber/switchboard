import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { D1Adapter, type D1DatabaseLike, type D1PreparedStatement } from '../../src/db/d1-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import type { DatabaseSession } from '../../src/db/database.js';

/**
 * Creates a D1-compliant test double wrapping a fresh SQLite database
 * to verify that D1 API semantics are strictly respected without any Node-specific shortcuts.
 */
function createSimulatedD1(): D1DatabaseLike {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON;');

  const makeStmt = (query: string, boundParams: unknown[] = []): D1PreparedStatement => {
    return {
      bind(...values: unknown[]) {
        return makeStmt(query, values);
      },
      async first<T = unknown>(_colName?: string): Promise<T | null> {
        const stmt = rawDb.prepare(query);
        const res = stmt.get(...(boundParams as any[]));
        return (res ?? null) as T | null;
      },
      async all<T = unknown>(): Promise<{ results?: T[]; success: boolean; meta?: any }> {
        const stmt = rawDb.prepare(query);
        const res = stmt.all(...(boundParams as any[]));
        return {
          results: res as unknown as T[],
          success: true,
          meta: {},
        };
      },
      async run(): Promise<{ success: boolean; meta?: { changes?: number; last_row_id?: number | bigint } }> {
        const stmt = rawDb.prepare(query);
        const res = stmt.run(...(boundParams as any[]));
        return {
          success: true,
          meta: {
            changes: Number(res.changes),
            last_row_id: res.lastInsertRowid,
          },
        };
      },
    };
  };

  return {
    prepare(query: string) {
      return makeStmt(query);
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      const results: Array<{ results?: T[]; success: boolean; meta?: any }> = [];
      for (const stmt of statements) {
        results.push(await stmt.all<T>());
      }
      return results;
    },
    async exec(query: string) {
      rawDb.exec(query);
      return { count: 1, duration: 1 };
    },
  };
}

describe.each([
  { profile: 'Self-Hosted (Node.js + SQLite)', createSession: () => new SqliteAdapter(':memory:') },
  { profile: 'Hosted (Cloudflare D1 Adapter)', createSession: () => new D1Adapter(createSimulatedD1()) },
])('Storage Profile Portability: $profile', ({ createSession }) => {
  let db: DatabaseSession;
  let authService: AuthService;
  let service: SwitchboardService;

  const projectId = 'proj-portability';
  const token = 'tok-portable';

  it('passes identical domain lifecycle contract across storage implementations', async () => {
    db = createSession();
    await initializeSchema(db);
    authService = new AuthService(db);
    service = new SwitchboardService(db);

    // 1. Provisioning
    await authService.createProject(projectId, 'Portability Project');
    await authService.registerEndpoint(projectId, 'port-a', 'Port Alpha', 'agent');
    await authService.registerEndpoint(projectId, 'port-b', 'Port Beta', 'agent');
    await authService.issueToken(projectId, 'port-a', token);

    const principalA = await authService.authenticate(`Bearer ${token}`);

    // 2. Send message and verify receipt
    const receipt = await service.sendMessage(principalA, {
      id: 'port-msg-1',
      recipientType: 'endpoint',
      recipientId: 'port-b',
      kind: 'port.v1',
      subject: 'Storage Test',
      payload: { platform: 'portable' },
    });

    expect(receipt.status).toBe('STORED');
    expect(receipt.messageId).toBe('port-msg-1');
    expect(receipt.recipientCount).toBe(1);

    // 3. Idempotent duplicate write
    const dupReceipt = await service.sendMessage(principalA, {
      id: 'port-msg-1',
      recipientType: 'endpoint',
      recipientId: 'port-b',
      kind: 'port.v1',
      subject: 'Storage Test',
      payload: { platform: 'portable' },
    });
    expect(dupReceipt.isDuplicate).toBe(true);

    // 4. Inbound retrieval for recipient B
    const principalB = {
      endpointId: 'port-b',
      projectId,
      scopes: ['read', 'write'],
      role: 'agent' as const,
    };

    const syncB = await service.sync(principalB, { limit: 10 });
    expect(syncB.inboundMessages).toHaveLength(1);
    expect(syncB.inboundMessages[0]?.id).toBe('port-msg-1');
    expect(syncB.inboundMessages[0]?.deliverySequence).toBe(1);

    // 5. Acknowledge delivery
    const acks = await service.acknowledge(principalB, [
      { messageId: 'port-msg-1', senderId: 'port-a' },
    ]);
    expect(acks).toHaveLength(1);
    expect(acks[0]?.status).toBe('ACKNOWLEDGED');

    // 6. Verify inbox shows zero unacknowledged
    const inbox = await service.getInbox(principalB);
    expect(inbox.total).toBe(0);

    // 7. Status update with revision
    const status = await service.updateStatus(principalA, {
      state: 'busy',
      description: 'Portable test running',
      expectedRevision: 1,
    });
    expect(status.state).toBe('busy');
    expect(status.revision).toBe(2);
  });
});
