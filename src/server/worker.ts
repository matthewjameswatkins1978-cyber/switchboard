import { D1Adapter } from '../db/d1-adapter.js';
import { AuthService } from '../auth/auth-service.js';
import { SwitchboardService } from '../core/service.js';
import { createSwitchboardApp } from '../http/app.js';
import { mountWebMcpRoutes } from '../mcp/mcp-web-handler.js';
import { checkReadiness, isPausedSetting } from '../operations/control.js';
import { runHousekeeping } from '../operations/housekeeping.js';

export interface Env {
  DB: any; // Cloudflare D1 binding
  ADMIN_TOKEN?: string;
  PROJECT_ID?: string;
  SWITCHBOARD_PAUSED?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = new D1Adapter(env.DB);
    const authService = new AuthService(db);
    const service = new SwitchboardService(db);

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
    });
    if (env.PROJECT_ID) {
      await service.createScheduledBackup(env.PROJECT_ID);
    }
  },
};
