import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import worker from '../../src/server/worker.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { D1Adapter, type D1DatabaseLike, type D1PreparedStatement } from '../../src/db/d1-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { createSwitchboardApp } from '../../src/http/app.js';
import { mountWebMcpRoutes } from '../../src/mcp/mcp-web-handler.js';
import { serve } from '@hono/node-server';

function createD1Mock(): D1DatabaseLike {
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

describe('Cloudflare Worker & Network MCP Streamable HTTP Integration', () => {
  // Part A: Worker execution
  it('Cloudflare Worker executes API routes, authenticated metrics, and Web MCP handler', async () => {
    const d1 = createD1Mock();
    const d1Adapter = new D1Adapter(d1);
    await initializeSchema(d1Adapter);

    const auth = new AuthService(d1Adapter);
    await auth.createProject('proj-worker-test', 'Worker Project');
    await auth.registerEndpoint('proj-worker-test', 'worker-agent-1', 'Worker Agent 1', 'agent');
    await auth.issueToken('proj-worker-test', 'worker-agent-1', 'tok-worker-secret-123');

    const env = { DB: d1 };

    // 1. Health check
    const healthReq = new Request('https://switchboard.workers.dev/health');
    const healthRes = await worker.fetch(healthReq, env);
    expect(healthRes.status).toBe(200);
    const healthJson = await healthRes.json();
    expect(healthJson.status).toBe('ok');

    // 2. Metrics authentication check
    const unauthMetrics = await worker.fetch(new Request('https://switchboard.workers.dev/metrics'), env);
    expect(unauthMetrics.status).toBe(401);

    const authMetrics = await worker.fetch(
      new Request('https://switchboard.workers.dev/metrics', {
        headers: { Authorization: 'Bearer tok-worker-secret-123' },
      }),
      env
    );
    expect(authMetrics.status).toBe(200);

    // 3. Send message via Worker fetch
    const sendReq = new Request('https://switchboard.workers.dev/api/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok-worker-secret-123',
      },
      body: JSON.stringify({
        id: 'msg-worker-101',
        recipientType: 'endpoint',
        recipientId: 'worker-agent-1',
        kind: 'task.v1',
        subject: 'Worker self message',
        payload: { ok: true },
      }),
    });
    const sendRes = await worker.fetch(sendReq, env);
    expect(sendRes.status).toBe(201);
    const receipt = await sendRes.json();
    expect(receipt.status).toBe('STORED');

    // 4. Mount and test Web MCP route on Worker
    const mcpReq = new Request('https://switchboard.workers.dev/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        Authorization: 'Bearer tok-worker-secret-123',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    const mcpRes = await worker.fetch(mcpReq, env);
    expect(mcpRes.status).toBe(200);
    const mcpText = await mcpRes.text();
    expect(mcpText).toContain('send_message');
    expect(mcpText).toContain('get_board');
  });

  // Part B: Real Authenticated Network MCP Roundtrip
  describe('Authenticated Network MCP Client over HTTP', () => {
    let server: any;
    let serverPort: number;
    let token = 'tok-network-mcp-999';

    beforeAll(async () => {
      const db = new SqliteAdapter(':memory:');
      await initializeSchema(db);
      const authService = new AuthService(db);
      const service = new SwitchboardService(db);

      await authService.createProject('proj-net-mcp', 'Network MCP');
      await authService.registerEndpoint('proj-net-mcp', 'net-mcp-client', 'Network Client', 'agent');
      await authService.registerEndpoint('proj-net-mcp', 'net-recipient', 'Recipient', 'agent');
      await authService.issueToken('proj-net-mcp', 'net-mcp-client', token);

      const app = createSwitchboardApp({ authService, service });
      mountWebMcpRoutes(app, { authService, service });

      // Start actual listening HTTP server on OS-assigned free port
      server = serve({
        fetch: app.fetch,
        port: 0,
        hostname: '127.0.0.1',
      });

      await new Promise<void>((resolve) => {
        server.listening ? resolve() : server.on('listening', resolve);
      });

      const addr = server.address();
      serverPort = typeof addr === 'object' && addr ? addr.port : 3000;
    });

    afterAll(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('performs full authenticated tool dispatch and synchronization over HTTP network transport', async () => {
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${serverPort}/mcp`),
        {
          requestInit: {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        }
      );

      const client = new Client({ name: 'network-test-client', version: '0.1.0' });
      await client.connect(transport);

      // 1. List tools over network
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThanOrEqual(10);

      // 2. Send message tool call
      const sendResult = (await client.callTool({
        name: 'send_message',
        arguments: {
          id: 'net-msg-001',
          recipient_type: 'endpoint',
          recipient_id: 'net-recipient',
          kind: 'network.task.v1',
          subject: 'Network verification',
          payload: JSON.stringify({ verified: true }),
        },
      })) as any;

      const receipt = JSON.parse(sendResult.content[0].text);
      expect(receipt.status).toBe('STORED');
      expect(receipt.messageId).toBe('net-msg-001');

      // 3. Board tool call
      const boardResult = (await client.callTool({
        name: 'get_board',
        arguments: {},
      })) as any;

      const board = JSON.parse(boardResult.content[0].text);
      expect(board.projectId).toBe('proj-net-mcp');
      expect(board.endpoints.length).toBe(2);

      await client.close();
    });
  });
});
