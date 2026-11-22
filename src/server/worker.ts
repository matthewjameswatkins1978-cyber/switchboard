import { D1Adapter } from '../db/d1-adapter.js';
import { AuthService } from '../auth/auth-service.js';
import { SwitchboardService } from '../core/service.js';
import { createSwitchboardApp } from '../http/app.js';

export interface Env {
  DB: any; // Cloudflare D1 binding
  ADMIN_TOKEN?: string;
  PROJECT_ID?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = new D1Adapter(env.DB);
    const authService = new AuthService(db);
    const service = new SwitchboardService(db);

    const app = createSwitchboardApp({ authService, service });
    return await app.fetch(request, env);
  },
};
