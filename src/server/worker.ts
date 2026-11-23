import { D1Adapter } from '../db/d1-adapter.js';
import { AuthService } from '../auth/auth-service.js';
import { SwitchboardService } from '../core/service.js';
import { createSwitchboardApp } from '../http/app.js';
import { mountWebMcpRoutes } from '../mcp/mcp-web-handler.js';
import { checkReadiness, isPausedSetting } from '../operations/control.js';
import { runHousekeeping } from '../operations/housekeeping.js';

import { routeChatGptOAuth, type ChatGptOAuthEnv } from '../auth/chatgpt-oauth.js';
import { serveWebMcp } from '../mcp/mcp-web-handler.js';
import type { DurableObjectState, KVNamespace } from '@cloudflare/workers-types';
import { OAuthRecords } from '../auth/oauth-records.js';
import { rotateOAuthToken } from '../auth/oauth-refresh.js';

export interface Env extends ChatGptOAuthEnv {
  DB: any; // Cloudflare D1 binding
  ADMIN_TOKEN?: string;
  PROJECT_ID?: string;
  SWITCHBOARD_PAUSED?: string;
}

type OAuthContext = Parameters<typeof routeChatGptOAuth>[2];

function serveOAuth(
  request: Request, env: Env, ctx: OAuthContext, db: D1Adapter,
  service: SwitchboardService, routedThroughState = false,
) {
  return routeChatGptOAuth(request, env, ctx, async (req, principal) => {
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
  }, routedThroughState);
}

export class ChatGptOAuthState {
  private queued: Promise<unknown> = Promise.resolve();

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    OAuthRecords.initialize(state.storage);
  }

  async fetch(request: Request): Promise<Response> {
    // Serialize grant issuance, retries and revocation on one consistent state.
    const result = this.queued.then(() => this.handle(request));
    this.queued = result.catch(() => undefined);
    return result;
  }

  private async handle(request: Request): Promise<Response> {
    const records = new OAuthRecords(this.state.storage, this.env.OAUTH_KV as KVNamespace);
    const db = new D1Adapter(this.env.DB);
    const service = new SwitchboardService(db);
    const context = { waitUntil: this.state.waitUntil.bind(this.state), passThroughOnException() {} };
    const issue = async () => (await serveOAuth(request, { ...this.env, OAUTH_KV: records },
      context, db, service, true)) ?? new Response(null, { status: 404 });
    const response = new URL(request.url).pathname === '/oauth/chatgpt/token'
      ? await rotateOAuthToken(request, this.env, records, issue)
      : await issue();
    // Publish the response only after grant, access token, and retry receipt commit together.
    records.commit();
    return response;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx?: Parameters<typeof routeChatGptOAuth>[2]): Promise<Response> {
    const db = new D1Adapter(env.DB);
    const authService = new AuthService(db);
    const service = new SwitchboardService(db);

    const oauth = await serveOAuth(request, env, ctx, db, service);
    if (oauth) return oauth;

    const app = createSwitchboardApp({ authService, service,
      paused: isPausedSetting(env.SWITCHBOARD_PAUSED),
      readiness: () => checkReadiness(db),
    });
    mountWebMcpRoutes(app, { authService, service });

    return await app.fetch(request, env);
  },

  async scheduled(_event: any, env: Env, _ctx: any): Promise<void> {
    if (isPausedSetting(env.SWITCHBOARD_PAUSED)) return;
    const db = new D1Adapter(env.DB);
    await runHousekeeping(db, {
      projectId: env.PROJECT_ID,
      maxItemsPerRun: 500,
    });
    // Hosted recovery uses an operator export stored outside the primary D1 database.
  },
};
