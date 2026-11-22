import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { MetricsCollector } from '../../src/core/metrics.js';
import type { AuthPrincipal } from '../../src/core/types.js';

function computeP95(durations: number[]): number {
  if (durations.length === 0) return 0;
  const sorted = [...durations].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.95);
  return sorted[idx] ?? sorted[sorted.length - 1] ?? 0;
}

describe('Capacity and Load Qualification (10 and 50 Endpoints)', () => {
  let db: SqliteAdapter;
  let authService: AuthService;
  let service: SwitchboardService;
  let metrics: MetricsCollector;

  const projectId = 'proj-load-test';

  beforeEach(async () => {
    metrics = new MetricsCollector();
    metrics.reset();
    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    authService = new AuthService(db);
    service = new SwitchboardService(db, metrics);

    await authService.createProject(projectId, 'Load Test Project');
  });

  it('qualifies 10 active endpoints under representative mixed load (p95 <= 2s)', async () => {
    const endpointCount = 10;
    const principals: AuthPrincipal[] = [];

    // Provision 10 endpoints
    for (let i = 0; i < endpointCount; i++) {
      const epId = `agent-10-${i}`;
      await authService.registerEndpoint(projectId, epId, `Agent ${i}`, 'agent');
      principals.push({
        endpointId: epId,
        projectId,
        scopes: ['read', 'write'],
        role: 'agent',
      });
    }

    const latencies: number[] = [];

    // Round 1: Each agent sends a message to the next agent (0 -> 1, 1 -> 2, ..., 9 -> 0)
    const sendPromises = principals.map(async (p, idx) => {
      const targetIdx = (idx + 1) % endpointCount;
      const targetId = principals[targetIdx]!.endpointId;

      const t0 = performance.now();
      const receipt = await service.sendMessage(p, {
        id: `load-10-msg-${idx}`,
        recipientType: 'endpoint',
        recipientId: targetId,
        kind: 'task.v1',
        subject: `Load test task from ${p.endpointId}`,
        payload: { source: idx, target: targetIdx, time: Date.now() },
        priority: 'normal',
      });
      const t1 = performance.now();
      latencies.push(t1 - t0);
      expect(receipt.status).toBe('STORED');
    });

    await Promise.all(sendPromises);

    // Round 2: Each agent syncs and receives the message
    const syncPromises = principals.map(async (p) => {
      const t0 = performance.now();
      const syncRes = await service.sync(p, { limit: 10 });
      const t1 = performance.now();
      latencies.push(t1 - t0);

      expect(syncRes.inboundMessages).toHaveLength(1);
      const inbound = syncRes.inboundMessages[0]!;

      // Round 3: Acknowledge the message
      const t2 = performance.now();
      await service.acknowledge(p, [
        { messageId: inbound.id, senderId: inbound.senderId },
      ]);
      const t3 = performance.now();
      latencies.push(t3 - t2);
    });

    await Promise.all(syncPromises);

    const p95 = computeP95(latencies);
    console.log(`[10 Endpoints Benchmark] Sample Count: ${latencies.length}, P95 Latency: ${p95.toFixed(2)} ms`);

    // Invariant: Healthy normal sync p95 <= 2s (2000 ms)
    expect(p95).toBeLessThan(2000);

    const snapshot = metrics.getSnapshot();
    expect(snapshot.acceptedMessages).toBe(10);
    expect(snapshot.acknowledgedDeliveries).toBe(10);
  });

  it('qualifies 50 endpoints under concurrent load with zero message loss or duplicate delivery', async () => {
    const endpointCount = 50;
    const principals: AuthPrincipal[] = [];

    // Provision 50 endpoints
    for (let i = 0; i < endpointCount; i++) {
      const epId = `agent-50-${i}`;
      await authService.registerEndpoint(projectId, epId, `Scale Agent ${i}`, 'agent');
      principals.push({
        endpointId: epId,
        projectId,
        scopes: ['read', 'write'],
        role: 'agent',
      });
    }

    const latencies: number[] = [];

    // Concurrent dispatch: Each endpoint sends to the next (ring topology)
    const sendPromises = principals.map(async (p, idx) => {
      const targetIdx = (idx + 1) % endpointCount;
      const targetId = principals[targetIdx]!.endpointId;

      const t0 = performance.now();
      const receipt = await service.sendMessage(p, {
        id: `scale-50-msg-${idx}`,
        recipientType: 'endpoint',
        recipientId: targetId,
        kind: 'scale.test.v1',
        subject: `Scale test payload ${idx}`,
        payload: { sender: p.endpointId, target: targetId },
      });
      const t1 = performance.now();
      latencies.push(t1 - t0);
      expect(receipt.status).toBe('STORED');
    });

    await Promise.all(sendPromises);

    // Concurrent sync & acknowledge across all 50 endpoints
    const syncPromises = principals.map(async (p) => {
      const t0 = performance.now();
      const syncRes = await service.sync(p, { limit: 10 });
      const t1 = performance.now();
      latencies.push(t1 - t0);

      expect(syncRes.inboundMessages).toHaveLength(1);
      const inbound = syncRes.inboundMessages[0]!;

      const t2 = performance.now();
      await service.acknowledge(p, [
        { messageId: inbound.id, senderId: inbound.senderId },
      ]);
      const t3 = performance.now();
      latencies.push(t3 - t2);
    });

    await Promise.all(syncPromises);

    const p95 = computeP95(latencies);
    console.log(`[50 Endpoints Benchmark] Sample Count: ${latencies.length}, P95 Latency: ${p95.toFixed(2)} ms`);

    // Verify p95 performance under 50 endpoints is well within the 2000 ms SLA
    expect(p95).toBeLessThan(2000);

    const snapshot = metrics.getSnapshot();
    expect(snapshot.acceptedMessages).toBe(50);
    expect(snapshot.acknowledgedDeliveries).toBe(50);
    expect(snapshot.totalCalls).toBe(150); // 50 sends + 50 syncs + 50 acks
  });
});
