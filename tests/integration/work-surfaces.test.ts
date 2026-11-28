import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { createSwitchboardMcpServer } from '../../src/mcp/mcp-server.js';
import { createSwitchboardApp } from '../../src/http/app.js';
import type { AuthPrincipal } from '../../src/core/types.js';

/**
 * SWB-SWEEP-001 — the work layer must be reachable through the existing
 * machine-operable surfaces without any change to messaging behaviour.
 */
describe('Work surfaces: MCP and HTTP', () => {
  const projectId = 'proj-surfaces';
  let db: SqliteAdapter;
  let auth: AuthService;
  let service: SwitchboardService;
  let lead: AuthPrincipal;
  let maker: AuthPrincipal;

  beforeEach(async () => {
    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    auth = new AuthService(db);
    service = new SwitchboardService(db);
    await auth.createProject(projectId, 'Surfaces');
    await auth.registerEndpoint(projectId, 'lead', 'Lead', 'admin');
    await auth.registerEndpoint(projectId, 'maker', 'Maker', 'agent');
    await auth.issueToken(projectId, 'lead', 'tok-lead');
    await auth.issueToken(projectId, 'maker', 'tok-maker');
    lead = await auth.authenticate('Bearer tok-lead');
    maker = await auth.authenticate('Bearer tok-maker');
  });

  it('exposes the work lifecycle over the official MCP client', async () => {
    const [leadTransport, leadServerTransport] = InMemoryTransport.createLinkedPair();
    const leadServer = createSwitchboardMcpServer(service, lead);
    const leadClient = new Client({ name: 'lead-client', version: '0.1.0' });
    await Promise.all([leadServer.connect(leadServerTransport), leadClient.connect(leadTransport)]);

    const [makerTransport, makerServerTransport] = InMemoryTransport.createLinkedPair();
    const makerServer = createSwitchboardMcpServer(service, maker);
    const makerClient = new Client({ name: 'maker-client', version: '0.1.0' });
    await Promise.all([makerServer.connect(makerServerTransport), makerClient.connect(makerTransport)]);

    const tools = (await leadClient.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      'commission_work',
      'claim_work',
      'update_work',
      'resolve_work',
      'supersede_work',
      'request_work_stop',
      'record_work_stop_handoff',
      'transfer_work',
      'reopen_work',
      'archive_work',
      'list_work',
      'get_work',
      'get_work_board',
      'related_work',
      'record_reconciliation',
      'transfer_commissionership',
    ]) {
      expect(tools).toContain(name);
    }

    const commissioned = await leadClient.callTool({
      name: 'commission_work',
      arguments: {
        id: 'mcp-work-1',
        operation_id: 'op-mcp-commission',
        objective: 'Prove the MCP work surface',
        priority: 'normal',
        scope_refs: ['src/work'],
      },
    });
    const commissionBody = JSON.parse((commissioned as any).content[0].text);
    expect(commissionBody.work.state).toBe('UNCLAIMED');
    expect(commissionBody.receipt.eventSeq).toBe(1);

    const claimed = await makerClient.callTool({
      name: 'claim_work',
      arguments: { work_id: 'mcp-work-1', operation_id: 'op-mcp-claim', expected_revision: 1 },
    });
    expect(JSON.parse((claimed as any).content[0].text).state).toBe('CLAIMED');

    const started = await makerClient.callTool({
      name: 'update_work',
      arguments: {
        work_id: 'mcp-work-1',
        operation_id: 'op-mcp-start',
        expected_revision: 2,
        to_state: 'IN_PROGRESS',
      },
    });
    expect(JSON.parse((started as any).content[0].text).state).toBe('IN_PROGRESS');

    const submitted = await makerClient.callTool({
      name: 'update_work',
      arguments: {
        work_id: 'mcp-work-1',
        operation_id: 'op-mcp-submit',
        expected_revision: 3,
        to_state: 'SUBMITTED',
      },
    });
    expect(JSON.parse((submitted as any).content[0].text).state).toBe('SUBMITTED');

    const resolved = await leadClient.callTool({
      name: 'resolve_work',
      arguments: {
        work_id: 'mcp-work-1',
        operation_id: 'op-mcp-resolve',
        expected_revision: 4,
        reason: 'COMPLETED',
      },
    });
    expect(JSON.parse((resolved as any).content[0].text).state).toBe('RESOLVED');

    const board = JSON.parse(
      ((await leadClient.callTool({ name: 'get_work_board', arguments: {} })) as any).content[0].text
    );
    expect(board.counts.resolved).toBe(1);

    const detail = JSON.parse(
      ((await leadClient.callTool({ name: 'get_work', arguments: { work_id: 'mcp-work-1' } })) as any).content[0].text
    );
    expect(detail.events).toHaveLength(5);

    // Messaging tools keep working beside the work tools.
    const send = await leadClient.callTool({
      name: 'send_message',
      arguments: {
        id: 'mcp-msg-beside-work',
        recipient_type: 'endpoint',
        recipient_id: 'maker',
        kind: 'chat/text.v1',
        subject: 'Messaging unchanged',
        payload: JSON.stringify({ text: 'hello' }),
      },
    });
    expect(JSON.parse((send as any).content[0].text).status).toBe('STORED');

    await leadClient.close();
    await makerClient.close();
  });

  it('serves the work routes over HTTP with the existing auth and protocol rules', async () => {
    const app = createSwitchboardApp({ authService: auth, service });
    const call = async (path: string, init: RequestInit = {}) =>
      await app.fetch(new Request(`http://localhost${path}`, init));

    const unauthorised = await call('/api/v1/work-board');
    expect(unauthorised.status).toBe(401);

    const wrongProtocol = await call('/api/v1/work', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-lead', 'Content-Type': 'application/json', 'X-Switchboard-Protocol': '99' },
      body: JSON.stringify({}),
    });
    expect(wrongProtocol.status).toBe(400);

    const created = await call('/api/v1/work', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-lead', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'http-work-1',
        operationId: 'op-http-commission',
        objective: 'Prove the HTTP work surface',
        priority: 'normal',
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.work.id).toBe('http-work-1');

    const claimed = await call('/api/v1/work/http-work-1/claim', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-maker', 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: 'op-http-claim', expectedRevision: 1 }),
    });
    expect(claimed.status).toBe(200);
    expect((await claimed.json()).state).toBe('CLAIMED');

    const board = await call('/api/v1/work-board', { headers: { Authorization: 'Bearer tok-lead' } });
    expect(board.status).toBe(200);
    expect((await board.json()).counts.active).toBe(1);

    const list = await call('/api/v1/work?limit=5', { headers: { Authorization: 'Bearer tok-lead' } });
    const listBody = await list.json();
    expect(listBody.items.map((item: { workId: string }) => item.workId)).toContain('http-work-1');

    const detail = await call('/api/v1/work/http-work-1', { headers: { Authorization: 'Bearer tok-lead' } });
    expect((await detail.json()).work.state).toBe('CLAIMED');

    const unknown = await call('/api/v1/work/http-work-1/teleport', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-lead', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(unknown.status).toBe(404);

    const stale = await call('/api/v1/work/http-work-1/transitions', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-maker', 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: 'op-http-stale', expectedRevision: 1, toState: 'IN_PROGRESS' }),
    });
    expect(stale.status).toBe(409);
  });
});
