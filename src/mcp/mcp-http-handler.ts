import type { Hono } from 'hono';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { AuthService } from '../auth/auth-service.js';
import type { SwitchboardService } from '../core/service.js';
import { createSwitchboardMcpServer } from './mcp-server.js';
import { SwitchboardError } from '../core/errors.js';

export function mountMcpRoutes(
  app: Hono,
  deps: {
    authService: AuthService;
    service: SwitchboardService;
  }
) {
  // Store active transports by sessionId
  const activeTransports = new Map<string, { transport: SSEServerTransport; server: any }>();

  // GET /mcp/sse - Establishes SSE stream
  app.get('/mcp/sse', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      throw new SwitchboardError('UNAUTHORIZED', 'Missing Authorization header for MCP SSE');
    }
    const principal = await deps.authService.authenticate(authHeader);

    // Node.js server context provides raw response via env
    const rawRes = (c.env as any)?.outgoing;

    if (!rawRes) {
      return c.text('MCP SSE transport requires Node HTTP runtime with raw response', 501);
    }

    const transport = new SSEServerTransport('/mcp/messages', rawRes);
    const mcpServer = createSwitchboardMcpServer(deps.service, principal);

    activeTransports.set(transport.sessionId, { transport, server: mcpServer });

    transport.onclose = () => {
      activeTransports.delete(transport.sessionId);
    };

    await mcpServer.connect(transport);

    // Return empty response since rawRes handles streaming headers and body
    return new Response(null);
  });

  // POST /mcp/messages - Client sends JSON-RPC messages
  app.post('/mcp/messages', async (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) {
      return c.text('Missing sessionId query parameter', 400);
    }

    const session = activeTransports.get(sessionId);
    if (!session) {
      return c.text('Unknown or expired MCP session', 404);
    }

    const rawReq = (c.env as any)?.incoming;
    const rawRes = (c.env as any)?.outgoing;

    if (rawReq && rawRes) {
      await session.transport.handlePostMessage(rawReq, rawRes);
      return new Response(null);
    }

    // Fallback if rawReq/rawRes not available (e.g. mock or test)
    const body = await c.req.json();
    await session.transport.handleMessage(body);
    return c.json({ jsonrpc: '2.0', result: 'accepted' });
  });
}
