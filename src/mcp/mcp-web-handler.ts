import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Hono } from 'hono';
import type { AuthService } from '../auth/auth-service.js';
import type { SwitchboardService } from '../core/service.js';
import { createSwitchboardMcpServer } from './mcp-server.js';
import { SwitchboardError } from '../core/errors.js';

export function mountWebMcpRoutes(
  app: Hono,
  deps: {
    authService: AuthService;
    service: SwitchboardService;
  }
) {
  // Stateless Streamable HTTP transport route for web standards (Cloudflare Workers, Bun, Node)
  app.all('/mcp', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      throw new SwitchboardError('UNAUTHORIZED', 'Missing Authorization header for MCP');
    }
    const principal = await deps.authService.authenticate(authHeader);
    const mcpServer = createSwitchboardMcpServer(deps.service, principal);

    // Stateless mode per official MCP spec
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await mcpServer.connect(transport);
    return await transport.handleRequest(c.req.raw);
  });
}
