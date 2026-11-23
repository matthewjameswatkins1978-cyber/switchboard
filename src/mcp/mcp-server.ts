import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SwitchboardService } from '../core/service.js';
import type { AuthPrincipal } from '../core/types.js';
import { AuthService } from '../auth/auth-service.js';
import { BudgetManager } from '../operations/budget.js';

export function createSwitchboardMcpServer(
  service: SwitchboardService,
  principal: AuthPrincipal,
  options: { audit?: (tool: string) => string; allowCredentialRotation?: boolean } = {},
): McpServer {
  const { audit } = options;
  const auditedResult = (tool: string, result: unknown) => {
    const content = [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }];
    if (!audit) return { content };
    const receipt = audit(tool);
    content.push({ type: 'text', text: 'Switchboard receipt ' + receipt });
    return { content, _meta: { 'switchboard/receipt': receipt } };
  };
  const server = new McpServer({
    name: 'switchboard',
    version: '0.1.0',
  });

  // 1. send_message
  server.tool(
    'send_message',
    {
      id: z.string().describe('Unique client idempotency ID'),
      recipient_type: z.enum(['endpoint', 'channel']),
      recipient_id: z.string().describe('Target endpoint ID or channel ID'),
      kind: z.string().describe('Namespaced versioned message kind (e.g. task.request.v1)'),
      subject: z.string().describe('Short summary of the message'),
      payload: z.string().describe('JSON string payload (max 32 KiB)'),
      priority: z.enum(['urgent', 'normal', 'low']).optional(),
      thread_id: z.string().optional(),
      reply_to_id: z.string().optional(),
      evidence_refs: z.array(z.string()).optional(),
    },
    async (params) => {
      let parsedPayload: unknown = null;
      try {
        parsedPayload = JSON.parse(params.payload);
      } catch {
        parsedPayload = params.payload;
      }

      const receipt = await service.sendMessage(principal, {
        id: params.id,
        recipientType: params.recipient_type,
        recipientId: params.recipient_id,
        kind: params.kind,
        subject: params.subject,
        payload: parsedPayload,
        priority: params.priority,
        threadId: params.thread_id,
        replyToId: params.reply_to_id,
        evidenceRefs: params.evidence_refs,
      });

      return auditedResult('send_message', receipt);
    }
  );

  // 2. sync
  server.tool(
    'sync',
    {
      since_cursor: z.string().optional().describe('Cursor from prior sync'),
      limit: z.number().int().min(1).max(32).optional(),
      include_acknowledged: z.boolean().optional(),
      outgoing_messages: z.string().optional().describe('JSON array of OutgoingMessageInput'),
      acknowledgements: z.string().optional().describe('JSON array of AckInput'),
      status_update: z.string().optional().describe('JSON StatusUpdateInput'),
    },
    async (params) => {
      let outgoingMessages = undefined;
      if (params.outgoing_messages) {
        try {
          outgoingMessages = JSON.parse(params.outgoing_messages);
        } catch {
          // invalid json handled by service
        }
      }

      let acks = undefined;
      if (params.acknowledgements) {
        try {
          acks = JSON.parse(params.acknowledgements);
        } catch {}
      }

      let statusUpdate = undefined;
      if (params.status_update) {
        try {
          statusUpdate = JSON.parse(params.status_update);
        } catch {}
      }

      const syncRes = await service.sync(principal, {
        sinceCursor: params.since_cursor,
        limit: params.limit,
        includeAcknowledged: params.include_acknowledged,
        outgoingMessages,
        acknowledgements: acks,
        statusUpdate,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(syncRes, null, 2) }],
      };
    }
  );

  // 3. get_inbox
  server.tool(
    'get_inbox',
    {
      limit: z.number().int().min(1).max(32).optional(),
      offset: z.number().int().min(0).optional(),
    },
    { readOnlyHint: true },
    async (params) => {
      const inbox = await service.getInbox(principal, params);
      return auditedResult('get_inbox', inbox);
    }
  );

  // 4. acknowledge
  server.tool(
    'acknowledge',
    {
      message_id: z.string().describe('Message ID to acknowledge'),
      sender_id: z.string().describe('Original sender ID'),
      note: z.string().optional(),
    },
    async (params) => {
      const receipts = await service.acknowledge(principal, [
        {
          messageId: params.message_id,
          senderId: params.sender_id,
          note: params.note,
        },
      ]);
      return auditedResult('acknowledge', receipts);
    }
  );

  // 5. get_message
  server.tool(
    'get_message',
    {
      message_id: z.string().describe('ID of message to retrieve'),
      sender_id: z.string().optional(),
    },
    async (params) => {
      const msg = await service.getMessage(principal, params.message_id, params.sender_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(msg, null, 2) }],
      };
    }
  );

  // 6. get_thread
  server.tool(
    'get_thread',
    {
      thread_id: z.string().describe('Thread ID to fetch conversation for'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (params) => {
      const msgs = await service.getThread(principal, params.thread_id, params.limit);
      return {
        content: [{ type: 'text', text: JSON.stringify(msgs, null, 2) }],
      };
    }
  );

  // 7. list_endpoints
  server.tool('list_endpoints', {}, { readOnlyHint: true }, async () => {
    const endpoints = await service.listEndpoints(principal);
    return auditedResult('list_endpoints', endpoints);
  });

  // 8. get_status
  server.tool(
    'get_status',
    {
      endpoint_id: z.string().describe('Endpoint ID to query'),
    },
    { readOnlyHint: true },
    async (params) => {
      const st = await service.getStatus(principal, params.endpoint_id);
      return auditedResult('get_status', st);
    }
  );

  // 9. update_status
  server.tool(
    'update_status',
    {
      state: z.enum(['available', 'busy', 'waiting', 'stale', 'offline']),
      description: z.string().optional(),
      expected_revision: z.number().int().optional(),
    },
    async (params) => {
      const updated = await service.updateStatus(principal, {
        state: params.state,
        description: params.description,
        expectedRevision: params.expected_revision,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }],
      };
    }
  );

  // 10. get_board
  server.tool('get_board', {}, async () => {
    const board = await service.getBoard(principal);
    return {
      content: [{ type: 'text', text: JSON.stringify(board, null, 2) }],
    };
  });

  // 11. get_budget
  server.tool('get_budget', {}, async () => {
    const report = await BudgetManager.getInstance().getReport(
      service.database,
      principal.projectId
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
    };
  });

  // OAuth grants must never mint independent, long-lived bearer credentials.
  if (options.allowCredentialRotation !== false) server.tool(
    'rotate_credential',
    {
      new_token: z.string().describe('New bearer token to issue'),
      old_token: z.string().optional().describe('Existing token being rotated'),
      grace_period_ms: z.number().int().optional().describe('Grace period in ms where old token remains valid'),
    },
    async (params) => {
      const auth = new AuthService(service.database);
      const result = await auth.rotateToken(principal.projectId, principal.endpointId, params.new_token, {
        oldToken: params.old_token,
        gracePeriodMs: params.grace_period_ms,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // 13. get_dead_letters
  server.tool(
    'get_dead_letters',
    {
      limit: z.number().int().min(1).max(32).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async (params) => {
      const res = await service.getDeadLetters(principal, params);
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
      };
    }
  );

  // 14. requeue_dead_letter
  server.tool(
    'requeue_dead_letter',
    {
      delivery_id: z.number().int().describe('ID of dead-letter delivery to requeue'),
    },
    async (params) => {
      const res = await service.requeueDeadLetter(principal, params.delivery_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
      };
    }
  );

  // 15. retire_endpoint
  server.tool(
    'retire_endpoint',
    {
      endpoint_id: z.string().describe('Endpoint ID to retire'),
      reason: z.string().optional().describe('Reason for retirement'),
    },
    async (params) => {
      const res = await service.retireEndpoint(principal, params.endpoint_id, params.reason);
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
      };
    }
  );

  return server;
}
