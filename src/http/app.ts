import { Hono } from 'hono';
import { AuthService } from '../auth/auth-service.js';
import { SwitchboardService } from '../core/service.js';
import { SwitchboardError } from '../core/errors.js';
import { MetricsCollector } from '../core/metrics.js';
import { renderDashboardHtml } from './dashboard.js';
import {
  MAX_AGGREGATE_BATCH_BYTES,
  MAX_BODY_BYTES,
  MAX_BATCH_MESSAGES,
  CreateEndpointSchema,
  CreateChannelSchema,
} from '../core/schema.js';
import type { AuthPrincipal } from '../core/types.js';
import { acceptsProtocol, PROTOCOL_HEADER, PROTOCOL_INFO } from '../operations/control.js';
import { runHousekeeping } from '../operations/housekeeping.js';
import { BudgetManager } from '../operations/budget.js';
import { WorkService } from '../work/work-service.js';

export interface AppDependencies {
  authService: AuthService;
  service: SwitchboardService;
  metrics?: MetricsCollector;
  rateLimitMaxPerMinute?: number;
  paused?: boolean;
  readiness?: () => Promise<boolean>;
}

export function createSwitchboardApp(deps: AppDependencies) {
  const app = new Hono();
  const auth = deps.authService;
  const svc = deps.service;
  const db = svc.database;
  const work = new WorkService(db);
  const metrics = deps.metrics ?? MetricsCollector.getInstance();
  const rateLimitMax = deps.rateLimitMaxPerMinute ?? 600; // 600 req/min default

  // Emergency brake applies before authorization and DB work, including MCP routes.
  // It rejects work; it never deletes accepted deliveries or changes credentials.
  app.use('*', async (c, next) => {
    const path = c.req.path;
    const discovery = path === '/api/v1/discovery';
    if (deps.paused && path !== '/health' && !discovery) {
      c.header('Retry-After', '120');
      return c.json({ error: { code: 'UNAVAILABLE', message: 'Service paused by operator' } }, 503);
    }
    if (path.startsWith('/api/v1/') && !discovery && !acceptsProtocol(c.req.header(PROTOCOL_HEADER))) {
      return c.json({ error: { code: 'UNSUPPORTED_PROTOCOL', message: 'Unsupported Switchboard protocol', supported: PROTOCOL_INFO.supported } }, 400);
    }
    await next();
    return undefined;
  });

  // In-memory rate limiting per principal
  const requestCounts = new Map<string, { count: number; resetAt: number }>();

  // Error handling middleware
  app.onError((err, c) => {
    if (err instanceof SwitchboardError) {
      if (err.retryAfterSeconds) {
        c.header('Retry-After', String(err.retryAfterSeconds));
      }
      return c.json(err.toJSON(), err.statusCode as any);
    }

    // Zod or other error
    if (err && (err as any).name === 'ZodError') {
      return c.json(
        {
          error: {
            code: 'INVALID_INPUT',
            message: 'Validation failed',
            details: (err as any).errors,
          },
        },
        400
      );
    }

    console.error('Unhandled server error:', err);
    return c.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: err.message ?? 'An unexpected internal error occurred',
        },
      },
      500
    );
  });

  // Health endpoint (public read-only)
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      version: '0.1.0',
      mode: deps.paused ? 'paused' : 'running',
      time: Date.now(),
    });
  });

  // Discovery endpoint
  app.get('/api/v1/discovery', (c) => {
    return c.json({
      name: 'Switchboard',
      version: '0.1.0',
      protocol: PROTOCOL_INFO,
      mode: deps.paused ? 'paused' : 'running',
      capabilities: {
        messaging: true,
        batchSync: true,
        acknowledgements: true,
        presence: true,
        channels: true,
        exportRestore: true,
        mcp: true,
      },
      limits: {
        maxInlineBodyBytes: MAX_BODY_BYTES,
        maxBatchMessages: MAX_BATCH_MESSAGES,
        maxAggregateBatchBytes: MAX_AGGREGATE_BATCH_BYTES,
      },
      serverTime: Date.now(),
    });
  });

  // Helper auth extractor
  async function requirePrincipal(c: any): Promise<AuthPrincipal> {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      throw new SwitchboardError('UNAUTHORIZED', 'Missing Authorization header');
    }
    const principal = await auth.authenticate(authHeader);

    // Rate limit check
    const now = Date.now();
    const key = `${principal.projectId}:${principal.endpointId}`;
    const windowRecord = requestCounts.get(key);

    if (!windowRecord || now > windowRecord.resetAt) {
      requestCounts.set(key, { count: 1, resetAt: now + 60000 });
    } else {
      windowRecord.count++;
      if (windowRecord.count > rateLimitMax) {
        throw new SwitchboardError('THROTTLED', 'Rate limit exceeded', {
          retryAfterSeconds: Math.ceil((windowRecord.resetAt - now) / 1000),
        });
      }
    }

    return principal;
  }

  // Authenticated readiness is separate from cheap public liveness. No background polling.
  app.get('/api/v1/readiness', async (c) => {
    try {
      await requirePrincipal(c);
    } catch (error) {
      if (error instanceof SwitchboardError) throw error;
      return c.json({ status: 'unavailable', ready: false }, 503);
    }
    let ready = false;
    try { ready = (await deps.readiness?.()) === true; } catch { /* no sensitive error details */ }
    c.header('Cache-Control', 'no-store');
    return c.json({ status: ready ? 'ready' : 'unavailable', ready }, ready ? 200 : 503);
  });

  // Work Board Human-facing Dashboard
  app.get('/board', async (c) => {
    try {
      const principal = await requirePrincipal(c);
      const board = await svc.getBoard(principal);
      const html = renderDashboardHtml(board, metrics.getSnapshot());
      return c.html(html);
    } catch (err: any) {
      if (err instanceof SwitchboardError && err.code === 'UNAUTHORIZED') {
        return c.text('Unauthorized: Provide Bearer token in Authorization header', 401);
      }
      throw err;
    }
  });

  // Metrics endpoint (authenticated)
  app.get('/metrics', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      throw new SwitchboardError('UNAUTHORIZED', 'Missing Authorization header for metrics');
    }
    await auth.authenticate(authHeader);
    return c.json(metrics.getSnapshot());
  });

  // Core API Routes
  app.post('/api/v1/messages', async (c) => {
    const principal = await requirePrincipal(c);
    const body = await c.req.json();
    const receipt = await svc.sendMessage(principal, body);
    return c.json(receipt, 201);
  });

  app.post('/api/v1/sync', async (c) => {
    const principal = await requirePrincipal(c);
    const body = await c.req.json();
    const response = await svc.sync(principal, body);
    return c.json(response);
  });

  app.get('/api/v1/inbox', async (c) => {
    const principal = await requirePrincipal(c);
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined;
    const inbox = await svc.getInbox(principal, { limit, offset });
    return c.json(inbox);
  });

  app.post('/api/v1/acknowledgements', async (c) => {
    const principal = await requirePrincipal(c);
    const body = await c.req.json();
    const acks = Array.isArray(body)
      ? body
      : Array.isArray(body?.acknowledgements)
        ? body.acknowledgements
        : [body];
    const receipts = await svc.acknowledge(principal, acks);
    return c.json({ receipts });
  });

  app.get('/api/v1/messages/:id', async (c) => {
    const principal = await requirePrincipal(c);
    const id = c.req.param('id');
    const senderId = c.req.query('senderId');
    const msg = await svc.getMessage(principal, id, senderId);
    return c.json(msg);
  });

  app.get('/api/v1/threads/:id', async (c) => {
    const principal = await requirePrincipal(c);
    const threadId = c.req.param('id');
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const thread = await svc.getThread(principal, threadId, limit);
    return c.json({ threadId, messages: thread });
  });

  app.get('/api/v1/endpoints', async (c) => {
    const principal = await requirePrincipal(c);
    const endpoints = await svc.listEndpoints(principal);
    return c.json({ endpoints });
  });

  app.get('/api/v1/endpoints/:id/status', async (c) => {
    const principal = await requirePrincipal(c);
    const id = c.req.param('id');
    const status = await svc.getStatus(principal, id);
    return c.json(status);
  });

  app.put('/api/v1/status', async (c) => {
    const principal = await requirePrincipal(c);
    const body = await c.req.json();
    const updated = await svc.updateStatus(principal, body);
    return c.json(updated);
  });

  app.get('/api/v1/board', async (c) => {
    const principal = await requirePrincipal(c);
    const board = await svc.getBoard(principal);
    return c.json(board);
  });

  // Work lifecycle (SWB-SWEEP-001). Additive: existing messaging routes are unchanged.
  app.get('/api/v1/work', async (c) => {
    const principal = await requirePrincipal(c);
    const limitParam = c.req.query('limit');
    return c.json(
      await work.list(principal, {
        state: c.req.query('state') || undefined,
        includeArchived: c.req.query('includeArchived') === 'true',
        limit: limitParam ? Number(limitParam) : undefined,
        cursor: c.req.query('cursor') || undefined,
      })
    );
  });

  app.post('/api/v1/work', async (c) => {
    const principal = await requirePrincipal(c);
    return c.json(await work.commission(principal, await c.req.json()), 201);
  });

  app.get('/api/v1/work-board', async (c) => {
    const principal = await requirePrincipal(c);
    return c.json(await work.board(principal));
  });

  app.post('/api/v1/work/related', async (c) => {
    const principal = await requirePrincipal(c);
    const body = await c.req.json().catch(() => ({}));
    return c.json(await work.relatedWork(principal, body));
  });

  app.get('/api/v1/work/:id', async (c) => {
    const principal = await requirePrincipal(c);
    return c.json(await work.get(principal, c.req.param('id')));
  });

  const workActions: Record<
    string,
    (principal: AuthPrincipal, body: Record<string, unknown>, workId: string) => Promise<unknown>
  > = {
    claim: (principal, body, workId) => work.claim(principal, { ...body, workId }),
    transitions: (principal, body, workId) => work.transition(principal, { ...body, workId }),
    resolve: (principal, body, workId) => work.resolve(principal, { ...body, workId }),
    supersede: (principal, body, workId) => work.supersede(principal, { ...body, workId }),
    stop: (principal, body, workId) => work.requestStop(principal, { ...body, workId }),
    'stop-handoff': (principal, body, workId) => work.recordStopHandoff(principal, { ...body, workId }),
    transfer: (principal, body, workId) => work.transfer(principal, { ...body, workId }),
    'release-proposal': (principal, body, workId) => work.proposeRelease(principal, { ...body, workId }),
    reopen: (principal, body, workId) => work.reopen(principal, { ...body, workId }),
    archive: (principal, body, workId) => work.archive(principal, { ...body, workId }),
  };

  app.post('/api/v1/work/:id/:action', async (c) => {
    const principal = await requirePrincipal(c);
    const action = workActions[c.req.param('action')];
    if (!action) {
      throw new SwitchboardError('NOT_FOUND', `Unknown work action '${c.req.param('action')}'`);
    }
    const body = await c.req.json().catch(() => ({}));
    return c.json(await action(principal, body, c.req.param('id')));
  });

  app.post('/api/v1/export', async (c) => {
    const principal = await requirePrincipal(c);
    const data = await svc.exportData(principal);
    return c.json(data);
  });

  app.post('/api/v1/import', async (c) => {
    const principal = await requirePrincipal(c);
    const body = await c.req.json();
    const res = await svc.importData(principal, body);
    return c.json(res);
  });

  // Admin / Channel management
  app.post('/api/v1/channels', async (c) => {
    const principal = await requirePrincipal(c);
    const body = await c.req.json();
    const parsed = CreateChannelSchema.parse(body);
    await svc.createChannel(principal, parsed.id, parsed.name, parsed.members ?? []);
    return c.json({ channelId: parsed.id, status: 'created' }, 201);
  });

  app.post('/api/v1/channels/:id/members', async (c) => {
    const principal = await requirePrincipal(c);
    const channelId = c.req.param('id');
    const body = await c.req.json();
    if (!body.endpointId) {
      throw new SwitchboardError('INVALID_INPUT', 'endpointId is required');
    }
    await svc.addChannelMember(principal, channelId, body.endpointId);
    return c.json({ channelId, memberId: body.endpointId, status: 'added' });
  });

  app.post('/api/v1/admin/endpoints', async (c) => {
    const principal = await requirePrincipal(c);
    if (principal.role !== 'admin') {
      throw new SwitchboardError('FORBIDDEN', 'Admin privileges required');
    }
    const body = await c.req.json();
    const parsed = CreateEndpointSchema.parse(body);
    await auth.registerEndpoint(principal.projectId, parsed.id, parsed.name, parsed.role);
    return c.json({ endpointId: parsed.id, status: 'registered' }, 201);
  });

  app.post('/api/v1/admin/tokens', async (c) => {
    const principal = await requirePrincipal(c);
    if (principal.role !== 'admin') {
      throw new SwitchboardError('FORBIDDEN', 'Admin privileges required');
    }
    const body = await c.req.json();
    if (!body.endpointId || !body.token) {
      throw new SwitchboardError('INVALID_INPUT', 'endpointId and token are required');
    }
    await auth.issueToken(
      principal.projectId,
      body.endpointId,
      body.token,
      body.scopes ?? ['read', 'write'],
      body.expiresInMs
    );
    return c.json({ endpointId: body.endpointId, status: 'issued' });
  });

  // Credential rotation
  app.post('/api/v1/auth/rotate', async (c) => {
    const principal = await requirePrincipal(c);
    const body = await c.req.json();
    if (!body.newToken) {
      throw new SwitchboardError('INVALID_INPUT', 'newToken is required for credential rotation');
    }
    const targetEndpointId = body.endpointId ?? principal.endpointId;
    if (principal.role !== 'admin' && targetEndpointId !== principal.endpointId) {
      throw new SwitchboardError(
        'FORBIDDEN',
        'Permission denied to rotate credentials for another endpoint'
      );
    }
    const result = await auth.rotateToken(principal.projectId, targetEndpointId, body.newToken, {
      oldToken: body.oldToken,
      gracePeriodMs: body.gracePeriodMs,
      scopes: body.scopes,
      newExpiresInMs: body.expiresInMs,
    });
    return c.json(result);
  });

  // Housekeeping
  app.post('/api/v1/admin/housekeeping', async (c) => {
    const principal = await requirePrincipal(c);
    if (principal.role !== 'admin') {
      throw new SwitchboardError('FORBIDDEN', 'Admin privileges required for housekeeping');
    }
    const body = await c.req.json().catch(() => ({}));
    const report = await runHousekeeping(db, {
      projectId: principal.projectId,
      retentionDays: body.retentionDays,
      deadLetterAgeDays: body.deadLetterAgeDays,
      auditLogRetentionDays: body.auditLogRetentionDays,
    });
    return c.json(report);
  });

  // Endpoint retirement
  app.post('/api/v1/admin/endpoints/:id/retire', async (c) => {
    const principal = await requirePrincipal(c);
    const targetEndpointId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const result = await svc.retireEndpoint(principal, targetEndpointId, body.reason);
    return c.json(result);
  });

  // Dead-letter management
  app.get('/api/v1/dead-letters', async (c) => {
    const principal = await requirePrincipal(c);
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined;
    const result = await svc.getDeadLetters(principal, { limit, offset });
    return c.json(result);
  });

  app.post('/api/v1/dead-letters/requeue', async (c) => {
    const principal = await requirePrincipal(c);
    const body = await c.req.json();
    if (body.deliveryId === undefined) {
      throw new SwitchboardError('INVALID_INPUT', 'deliveryId is required');
    }
    const result = await svc.requeueDeadLetter(principal, body.deliveryId);
    return c.json(result);
  });

  // Backups
  app.post('/api/v1/admin/backups', async (c) => {
    const principal = await requirePrincipal(c);
    if (principal.role !== 'admin') {
      throw new SwitchboardError('FORBIDDEN', 'Admin privileges required');
    }
    const backup = await svc.createScheduledBackup(principal.projectId);
    return c.json(backup, 201);
  });

  app.get('/api/v1/admin/backups', async (c) => {
    const principal = await requirePrincipal(c);
    if (principal.role !== 'admin') {
      throw new SwitchboardError('FORBIDDEN', 'Admin privileges required');
    }
    const backups = await svc.listBackups(principal);
    return c.json({ backups });
  });

  app.post('/api/v1/admin/backups/:id/restore', async (c) => {
    const principal = await requirePrincipal(c);
    const backupId = c.req.param('id');
    const result = await svc.restoreFromBackup(principal, backupId);
    return c.json(result);
  });

  app.post('/api/v1/admin/backups/restore-file', async (c) => {
    const principal = await requirePrincipal(c);
    if (principal.role !== 'admin') {
      throw new SwitchboardError('FORBIDDEN', 'Admin privileges required');
    }
    const body = await c.req.json();
    const result = await svc.importData(principal, body);
    return c.json(result);
  });

  // Budget
  app.get('/api/v1/budget', async (c) => {
    const principal = await requirePrincipal(c);
    const report = await BudgetManager.getInstance().getReport(db, principal.projectId);
    return c.json(report);
  });

  app.put('/api/v1/admin/budget', async (c) => {
    const principal = await requirePrincipal(c);
    if (principal.role !== 'admin') {
      throw new SwitchboardError('FORBIDDEN', 'Admin privileges required');
    }
    const body = await c.req.json();
    await BudgetManager.getInstance().setLimits(db, principal.projectId, body);
    const report = await BudgetManager.getInstance().getReport(db, principal.projectId);
    return c.json(report);
  });

  return app;
}
