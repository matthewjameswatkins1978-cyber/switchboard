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

export interface AppDependencies {
  authService: AuthService;
  service: SwitchboardService;
  metrics?: MetricsCollector;
  rateLimitMaxPerMinute?: number;
}

export function createSwitchboardApp(deps: AppDependencies) {
  const app = new Hono();
  const auth = deps.authService;
  const svc = deps.service;
  const metrics = deps.metrics ?? MetricsCollector.getInstance();
  const rateLimitMax = deps.rateLimitMaxPerMinute ?? 600; // 600 req/min default

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
      time: Date.now(),
    });
  });

  // Discovery endpoint
  app.get('/api/v1/discovery', (c) => {
    return c.json({
      name: 'Switchboard',
      version: '0.1.0',
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

  // Metrics endpoint
  app.get('/metrics', async (c) => {
    // Optionally allow token check or admin scope
    const authHeader = c.req.header('Authorization');
    if (authHeader) {
      await auth.authenticate(authHeader);
    }
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
    const acks = Array.isArray(body) ? body : [body];
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

  return app;
}
