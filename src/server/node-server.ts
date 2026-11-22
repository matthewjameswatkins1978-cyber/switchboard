import { serve } from '@hono/node-server';
import { SqliteAdapter } from '../db/sqlite-adapter.js';
import { initializeSchema } from '../db/schema.js';
import { AuthService } from '../auth/auth-service.js';
import { SwitchboardService } from '../core/service.js';
import { createSwitchboardApp } from '../http/app.js';
import { mountMcpRoutes } from '../mcp/mcp-http-handler.js';

export async function startServer(options?: {
  port?: number;
  host?: string;
  databasePath?: string;
  adminToken?: string;
}) {
  const port = options?.port ?? Number(process.env.PORT ?? 3000);
  const host = options?.host ?? process.env.HOST ?? '0.0.0.0';
  const dbPath = options?.databasePath ?? process.env.DATABASE_PATH ?? 'switchboard.sqlite';

  const db = new SqliteAdapter(dbPath);
  await initializeSchema(db);

  const authService = new AuthService(db);
  const service = new SwitchboardService(db);

  // If initial admin token is provided, bootstrap default admin endpoint
  const adminToken = options?.adminToken ?? process.env.INITIAL_ADMIN_TOKEN;
  if (adminToken) {
    const adminProjectId = process.env.DEFAULT_PROJECT_ID ?? 'default';
    await authService.registerEndpoint(adminProjectId, 'admin', 'System Administrator', 'admin');
    await authService.issueToken(adminProjectId, 'admin', adminToken, ['read', 'write', 'admin']);
    console.log(`[Switchboard] Initial admin endpoint provisioned for project '${adminProjectId}'`);
  }

  const app = createSwitchboardApp({ authService, service });
  mountMcpRoutes(app, { authService, service });

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });

  console.log(`[Switchboard] Listening on http://${host}:${port}`);
  return { server, app, db, authService, service };
}

// When executed directly
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  startServer().catch((err) => {
    console.error('Fatal error starting Switchboard:', err);
    process.exit(1);
  });
}
