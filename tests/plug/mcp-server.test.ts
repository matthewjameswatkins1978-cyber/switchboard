import { describe, it, expect, beforeEach } from 'vitest';
import { SwitchboardPlug } from '../../src/plug/switchboard-plug.js';
import { MemoryClientStorage } from '../../src/client/switchboard-client.js';
import { createPlugMcpServer } from '../../src/plug/mcp-server.js';

describe('Switchboard Plug MCP Server Tools', () => {
  let memory: MemoryClientStorage;
  let plug: SwitchboardPlug;
  let mcpServer: ReturnType<typeof createPlugMcpServer>;

  beforeEach(() => {
    memory = new MemoryClientStorage();
    plug = new SwitchboardPlug(
      {
        endpointId: 'antigravity-mcp',
        projectId: 'workshop',
      },
      memory
    );
    mcpServer = createPlugMcpServer(plug);
  });

  it('registers all 10 expected tools with correct schemas', () => {
    // Inspect registered tools on the server
    const tools = (mcpServer as any)._registeredTools;
    expect(tools).toBeDefined();

    const toolNames = Object.keys(tools).sort();
    expect(toolNames).toEqual([
      'sb_acknowledge',
      'sb_board',
      'sb_endpoints',
      'sb_identify',
      'sb_inbox',
      'sb_read_message',
      'sb_reply',
      'sb_send_message',
      'sb_status',
      'sb_sync',
    ]);
  });

  it('executes sb_identify tool returning valid JSON facts', async () => {
    const tools = (mcpServer as any)._registeredTools;
    const identifyTool = tools['sb_identify'];
    expect(identifyTool).toBeDefined();

    const result = await identifyTool.handler({}, {});
    expect(result.content).toBeDefined();
    expect(result.content[0]?.type).toBe('text');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.endpointId).toBe('antigravity-mcp');
    expect(parsed.host).toContain('Antigravity');
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.stats.inboxCount).toBe(0);
  });

  it('executes sb_send_message and sb_inbox tools', async () => {
    const tools = (mcpServer as any)._registeredTools;

    // Send a message
    const sendResult = await tools['sb_send_message'].handler(
      {
        to: 'pi',
        subject: 'Run qualification bat',
        payload: JSON.stringify({ bat: 'BAT-005' }),
        priority: 'urgent',
      },
      {}
    );

    const sent = JSON.parse(sendResult.content[0].text);
    expect(sent.message.recipientId).toBe('pi');
    expect(sent.message.subject).toBe('Run qualification bat');

    // Seed inbox
    memory.save({
      outbox: sent.message ? [{ message: sent.message, enqueuedAt: Date.now(), attempts: 0 }] : [],
      pendingAcks: [],
      inbox: [
        {
          id: 'inbound-001',
          senderId: 'pi',
          projectId: 'workshop',
          recipientType: 'endpoint',
          recipientId: 'antigravity-mcp',
          kind: 'task.status.v1',
          subject: 'Bat completed',
          payload: { passed: true },
          priority: 'normal',
          serverCreatedAt: Date.now(),
          deliverySequence: 1,
          deliveryStatus: 'STORED',
        },
      ],
    });
    plug.client.reload();

    // Query inbox
    const inboxResult = await tools['sb_inbox'].handler({}, {});
    const inbox = JSON.parse(inboxResult.content[0].text);
    expect(inbox.total).toBe(1);
    expect(inbox.messages[0].id).toBe('inbound-001');

    // Read full message
    const readResult = await tools['sb_read_message'].handler(
      { message_id: 'inbound-001' },
      {}
    );
    const read = JSON.parse(readResult.content[0].text);
    expect(read.id).toBe('inbound-001');
    expect(read.payload.passed).toBe(true);

    // Reply
    const replyResult = await tools['sb_reply'].handler(
      {
        reply_to_id: 'inbound-001',
        payload: JSON.stringify({ verified: true }),
      },
      {}
    );
    const reply = JSON.parse(replyResult.content[0].text);
    expect(reply.message.recipientId).toBe('pi');
    expect(reply.message.replyToId).toBe('inbound-001');
    expect(reply.message.subject).toBe('Re: Bat completed');

    // Acknowledge
    const ackResult = await tools['sb_acknowledge'].handler(
      {
        message_id: 'inbound-001',
        note: 'Verified in MCP tool',
      },
      {}
    );
    const ack = JSON.parse(ackResult.content[0].text);
    expect(ack.acknowledged).toBe(true);
  });
});
