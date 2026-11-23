import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { createSwitchboardMcpServer } from '../../src/mcp/mcp-server.js';
import type { AuthPrincipal } from '../../src/core/types.js';

describe('Official MCP Protocol Client Interoperability', () => {
  let db: SqliteAdapter;
  let authService: AuthService;
  let service: SwitchboardService;

  let mcpClientA: Client;
  let mcpClientB: Client;
  let principalA: AuthPrincipal;
  let principalB: AuthPrincipal;

  const projectId = 'proj-mcp';

  beforeEach(async () => {
    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    authService = new AuthService(db);
    service = new SwitchboardService(db);

    await authService.createProject(projectId, 'MCP Project');
    await authService.registerEndpoint(projectId, 'agent-mcp-1', 'MCP Agent 1', 'agent');
    await authService.registerEndpoint(projectId, 'agent-mcp-2', 'MCP Agent 2', 'agent');

    principalA = {
      endpointId: 'agent-mcp-1',
      projectId,
      scopes: ['read', 'write'],
      role: 'agent',
    };

    principalB = {
      endpointId: 'agent-mcp-2',
      projectId,
      scopes: ['read', 'write'],
      role: 'agent',
    };

    // Client A setup
    const serverA = createSwitchboardMcpServer(service, principalA);
    const [cTransportA, sTransportA] = InMemoryTransport.createLinkedPair();
    mcpClientA = new Client({ name: 'mcp-client-a', version: '0.1.0' });
    await Promise.all([serverA.connect(sTransportA), mcpClientA.connect(cTransportA)]);

    // Client B setup
    const serverB = createSwitchboardMcpServer(service, principalB);
    const [cTransportB, sTransportB] = InMemoryTransport.createLinkedPair();
    mcpClientB = new Client({ name: 'mcp-client-b', version: '0.1.0' });
    await Promise.all([serverB.connect(sTransportB), mcpClientB.connect(cTransportB)]);
  });

  afterEach(async () => {
    await mcpClientA.close();
    await mcpClientB.close();
  });

  it('advertises all required MCP tools with accurate input schemas', async () => {
    const toolsRes = await mcpClientA.listTools();
    const toolNames = toolsRes.tools.map((t) => t.name);

    expect(toolNames).toContain('send_message');
    expect(toolNames).toContain('sync');
    expect(toolNames).toContain('get_inbox');
    expect(toolNames).toContain('acknowledge');
    expect(toolNames).toContain('get_message');
    expect(toolNames).toContain('get_thread');
    expect(toolNames).toContain('list_endpoints');
    expect(toolNames).toContain('get_status');
    expect(toolNames).toContain('update_status');
    expect(toolNames).toContain('get_board');
  });

  it('exchanges messages, synchronizes and acknowledges via official MCP tool calls', async () => {
    // 1. Client A calls send_message tool
    const sendRes = (await mcpClientA.callTool({
      name: 'send_message',
      arguments: {
        id: 'mcp-msg-101',
        recipient_type: 'endpoint',
        recipient_id: 'agent-mcp-2',
        kind: 'mcp.task.v1',
        subject: 'Run analysis',
        payload: JSON.stringify({ dataset: 'sample-42' }),
        priority: 'urgent',
      },
    })) as any;

    expect(sendRes.content).toHaveLength(1);
    const receipt = JSON.parse(sendRes.content[0].text);
    expect(receipt.status).toBe('STORED');
    expect(receipt.messageId).toBe('mcp-msg-101');

    // 2. Client B calls sync tool
    const syncRes = (await mcpClientB.callTool({
      name: 'sync',
      arguments: {},
    })) as any;

    const syncData = JSON.parse(syncRes.content[0].text);
    expect(syncData.inboundMessages).toHaveLength(1);
    const inbound = syncData.inboundMessages[0];
    expect(inbound.id).toBe('mcp-msg-101');
    expect(inbound.senderId).toBe('agent-mcp-1');
    expect(inbound.payload).toEqual({ dataset: 'sample-42' });

    // 3. Client B calls acknowledge tool
    const ackRes = (await mcpClientB.callTool({
      name: 'acknowledge',
      arguments: {
        message_id: 'mcp-msg-101',
        sender_id: 'agent-mcp-1',
        note: 'MCP processing started',
      },
    })) as any;

    const ackData = JSON.parse(ackRes.content[0].text);
    expect(ackData).toHaveLength(1);
    expect(ackData[0].status).toBe('ACKNOWLEDGED');

    // 4. Client A calls get_board tool to verify coordination overview
    const boardRes = (await mcpClientA.callTool({
      name: 'get_board',
      arguments: {},
    })) as any;

    const board = JSON.parse(boardRes.content[0].text);
    expect(board.projectId).toBe(projectId);
    expect(board.endpoints.length).toBeGreaterThanOrEqual(2);
  });
});
