import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SwitchboardPlug } from './switchboard-plug.js';

export function createPlugMcpServer(plug: SwitchboardPlug): McpServer {
  const server = new McpServer({
    name: 'switchboard-antigravity-plug',
    version: '0.1.0',
  });

  // 1. sb_identify
  server.tool(
    'sb_identify',
    'Get Switchboard agent identity, session facts, and local mailbox stats',
    {},
    async () => {
      const info = plug.identify();
      return {
        content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
      };
    }
  );

  // 2. sb_inbox
  server.tool(
    'sb_inbox',
    'Query inbox with progressive disclosure (compact headers). Use unread_only to filter.',
    {
      unread_only: z.boolean().optional().describe('Only return unread messages (default false)'),
      limit: z.number().int().min(1).max(32).optional().describe('Maximum messages to return (default 32)'),
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0)'),
      sync_first: z.boolean().optional().describe('Trigger sync with server before listing (default false)'),
    },
    async (params) => {
      const inbox = await plug.getInbox({
        unreadOnly: params.unread_only,
        limit: params.limit,
        offset: params.offset,
        syncFirst: params.sync_first,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(inbox, null, 2) }],
      };
    }
  );

  // 3. sb_read_message
  server.tool(
    'sb_read_message',
    'Read full message envelope and body by ID, marking it read locally',
    {
      message_id: z.string().describe('The ID of the message to read'),
    },
    async (params) => {
      try {
        const msg = plug.readMessage(params.message_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(msg, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    }
  );

  // 4. sb_send_message
  server.tool(
    'sb_send_message',
    'Send an addressed message to an endpoint or channel',
    {
      to: z.string().describe('Target recipient endpoint ID or channel ID'),
      subject: z.string().describe('Short subject/summary of the message'),
      payload: z.string().describe('JSON or string payload content (max 32 KiB)'),
      recipient_type: z.enum(['endpoint', 'channel']).optional().describe('Recipient type (default endpoint)'),
      kind: z.string().optional().describe('Message kind (default message.v1)'),
      priority: z.enum(['urgent', 'normal', 'low']).optional().describe('Priority level'),
      thread_id: z.string().optional().describe('Optional thread ID for correlation'),
      reply_to_id: z.string().optional().describe('Optional originating message ID'),
      evidence_refs: z.array(z.string()).optional().describe('Optional evidence or commit references'),
      immediate: z.boolean().optional().describe('Send immediately via direct REST call instead of queuing'),
    },
    async (params) => {
      let parsedPayload: unknown = params.payload;
      try {
        parsedPayload = JSON.parse(params.payload);
      } catch {
        // Keep string if not valid JSON
      }

      try {
        const result = await plug.sendMessage({
          to: params.to,
          recipientType: params.recipient_type,
          subject: params.subject,
          payload: parsedPayload,
          kind: params.kind,
          priority: params.priority,
          threadId: params.thread_id,
          replyToId: params.reply_to_id,
          evidenceRefs: params.evidence_refs,
          immediate: params.immediate,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    }
  );

  // 5. sb_reply
  server.tool(
    'sb_reply',
    'Reply to a received message by its message_id with automatic recipient, thread, and subject correlation',
    {
      reply_to_id: z.string().describe('The message ID being replied to'),
      subject: z.string().optional().describe('Reply subject (defaults to Re: <original-subject>)'),
      payload: z.string().describe('JSON or string payload content'),
      kind: z.string().optional().describe('Reply kind (defaults to reply.v1)'),
      priority: z.enum(['urgent', 'normal', 'low']).optional(),
      evidence_refs: z.array(z.string()).optional(),
      immediate: z.boolean().optional().describe('Send immediately via direct REST call'),
    },
    async (params) => {
      let parsedPayload: unknown = params.payload;
      try {
        parsedPayload = JSON.parse(params.payload);
      } catch {
        // Keep string
      }

      try {
        const result = await plug.reply({
          replyToId: params.reply_to_id,
          subject: params.subject,
          payload: parsedPayload,
          kind: params.kind,
          priority: params.priority,
          evidenceRefs: params.evidence_refs,
          immediate: params.immediate,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    }
  );

  // 6. sb_acknowledge
  server.tool(
    'sb_acknowledge',
    'Explicitly acknowledge receipt of a delivery',
    {
      message_id: z.string().describe('The message ID to acknowledge'),
      sender_id: z.string().optional().describe('Sender endpoint ID (optional if message in local inbox)'),
      note: z.string().optional().describe('Optional acknowledgement note'),
      immediate: z.boolean().optional().describe('Submit ack immediately via REST call'),
    },
    async (params) => {
      try {
        const result = await plug.acknowledge({
          messageId: params.message_id,
          senderId: params.sender_id,
          note: params.note,
          immediate: params.immediate,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    }
  );

  // 7. sb_sync
  server.tool(
    'sb_sync',
    'Perform an immediate synchronization cycle (flush outbox/acks, fetch fresh messages)',
    {},
    async () => {
      try {
        const res = await plug.sync();
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    }
  );

  // 8. sb_status
  server.tool(
    'sb_status',
    'Update presence status (available, busy, waiting, idle)',
    {
      state: z.enum(['available', 'busy', 'waiting', 'offline']).describe('Endpoint operational presence state'),
      description: z.string().optional().describe('Status description'),
      immediate: z.boolean().optional().describe('Update immediately via REST call'),
    },
    async (params) => {
      try {
        await plug.updateStatus({
          state: params.state,
          description: params.description,
          immediate: params.immediate,
        });

        return {
          content: [{ type: 'text', text: `Status updated to ${params.state}: ${params.description ?? ''}` }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    }
  );

  // 9. sb_endpoints
  server.tool(
    'sb_endpoints',
    'List registered endpoints in the project and their presence freshness',
    {},
    async () => {
      try {
        const endpoints = await plug.listEndpoints();
        return {
          content: [{ type: 'text', text: JSON.stringify(endpoints, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    }
  );

  // 10. sb_board
  server.tool(
    'sb_board',
    'Get compact coordination board overview with endpoints, unacked counts, and recent messages',
    {},
    async () => {
      try {
        const board = await plug.getBoard();
        return {
          content: [{ type: 'text', text: JSON.stringify(board, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    }
  );

  return server;
}

export async function runPlugMcpServer(plug?: SwitchboardPlug): Promise<void> {
  const instance = plug ?? new SwitchboardPlug();
  const server = createPlugMcpServer(instance);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// When executed directly as entrypoint
if (process.argv[1] && process.argv[1].endsWith('mcp-server.js')) {
  runPlugMcpServer().catch((err) => {
    console.error('Fatal MCP Server Error:', err);
    process.exit(1);
  });
}
