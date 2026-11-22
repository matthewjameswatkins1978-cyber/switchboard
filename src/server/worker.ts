import { D1Adapter } from '../db/d1-adapter.js';
import { AuthService } from '../auth/auth-service.js';
import { SwitchboardService } from '../core/service.js';
import { createSwitchboardApp } from '../http/app.js';
import { mountWebMcpRoutes } from '../mcp/mcp-web-handler.js';
import { checkReadiness, isPausedSetting } from '../operations/control.js';
import { runHousekeeping } from '../operations/housekeeping.js';

import { routeChatGptOAuth, type ChatGptOAuthEnv } from '../auth/chatgpt-oauth.js';
import { serveWebMcp } from '../mcp/mcp-web-handler.js';

export interface Env extends ChatGptOAuthEnv {
  DB: any; // Cloudflare D1 binding
  ADMIN_TOKEN?: string;
  PROJECT_ID?: string;
  SWITCHBOARD_PAUSED?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx?: Parameters<typeof routeChatGptOAuth>[2]): Promise<Response> {
    const db = new D1Adapter(env.DB);
    const authService = new AuthService(db);
    const service = new SwitchboardService(db);

    const oauth = await routeChatGptOAuth(request, env, ctx, async (req, principal) => {
      if (isPausedSetting(env.SWITCHBOARD_PAUSED)) {
        return new Response(null, { status: 503, headers: { 'Retry-After': '120' } });
      }
      const endpoint = await db.queryFirst<{ role: string; state: string }>(
        `SELECT e.role, s.state FROM endpoints e
         JOIN endpoint_status s ON s.endpoint_id = e.id AND s.project_id = e.project_id
         WHERE e.id = ? AND e.project_id = ?`,
        [principal.endpointId, principal.projectId],
      );
      if (endpoint?.role !== 'agent' || endpoint.state === 'retired') {
        return new Response(null, { status: 403 });
      }
      return serveWebMcp(req, service, principal, {
        allowCredentialRotation: false,
        audit(tool) {
          const receiptId = crypto.randomUUID();
          console.info(JSON.stringify({ event: 'switchboard.oauth.tool', tool, receiptId }));
          return receiptId;
        },
      });
    });
    if (oauth) return oauth;

    const app = createSwitchboardApp({ authService, service,
      paused: isPausedSetting(env.SWITCHBOARD_PAUSED),
      readiness: () => checkReadiness(db),
    });
    mountWebMcpRoutes(app, { authService, service });

    return await app.fetch(request, env);
  },

  async scheduled(_event: any, env: Env, _ctx: any): Promise<void> {
    const db = new D1Adapter(env.DB);
    const service = new SwitchboardService(db);
    await runHousekeeping(db, {
      projectId: env.PROJECT_ID,
      maxItemsPerRun: 500,
    });
    if (env.PROJECT_ID) {
      await service.createScheduledBackup(env.PROJECT_ID);
    }
  },
};
