import { serve } from '@hono/node-server';
import { SqliteAdapter } from '../db/sqlite-adapter.js';
import { initializeSchema } from '../db/schema.js';
import { AuthService } from '../auth/auth-service.js';
import { SwitchboardService } from '../core/service.js';
import { createSwitchboardApp } from '../http/app.js';
import { mountMcpRoutes } from '../mcp/mcp-http-handler.js';
import { mountWebMcpRoutes } from '../mcp/mcp-web-handler.js';
import { Telemetry, observeFetch } from '../telemetry/adapter.js';
import { JsonlTransport } from '../telemetry/jsonl.js';
import { checkReadiness, isPausedSetting } from '../operations/control.js';

export async function startServer(options?: {
  port?: number;
  host?: string;
  databasePath?: string;
  adminToken?: string;
  telemetryDirectory?: string;
  paused?: boolean;
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

  const app = createSwitchboardApp({ authService, service,
    paused: options?.paused ?? isPausedSetting(process.env.SWITCHBOARD_PAUSED),
    readiness: () => checkReadiness(db),
  });
  mountMcpRoutes(app, { authService, service });
  mountWebMcpRoutes(app, { authService, service });

  // Disabled unless explicitly selected; no directory or file is created otherwise.
  const telemetryDirectory = options?.telemetryDirectory ?? (process.env.SWITCHBOARD_TELEMETRY === '1'
    ? process.env.SWITCHBOARD_TELEMETRY_DIR ?? '.switchboard-telemetry'
    : undefined);
  let telemetry: Telemetry | undefined;
  if (telemetryDirectory) {
    try { telemetry = new Telemetry(new JsonlTransport(telemetryDirectory)); } catch { /* optional */ }
  }
  const server = serve({
    fetch: telemetry ? observeFetch(telemetry, app.fetch) : app.fetch,
    port,
    hostname: host,
  });
  if (telemetry) {
    const observer = telemetry;
    observer.emit('session.started');
    server.once('close', () => {
      observer.emit('session.stopped');
      void observer.close();
    });
  }

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
