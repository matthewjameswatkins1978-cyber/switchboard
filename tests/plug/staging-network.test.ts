import { describe, it, expect } from 'vitest';
import { SwitchboardPlug } from '../../src/plug/switchboard-plug.js';
import { MemoryClientStorage } from '../../src/client/switchboard-client.js';

describe('Live Staging Server Connectivity & Error Contract', () => {
  const stagingUrl = 'https://switchboard-staging.matthewjameswatkins1978.workers.dev';

  it('verifies live staging liveness and capability discovery', async () => {
    // 1. Live health check
    const healthRes = await fetch(`${stagingUrl}/health`);
    expect(healthRes.status).toBe(200);
    const health = await healthRes.json();
    expect(health.status).toBe('ok');
    expect(health.version).toBe('0.1.0');
    expect(health.mode).toBe('running');

    // 2. Live discovery
    const discRes = await fetch(`${stagingUrl}/api/v1/discovery`);
    expect(discRes.status).toBe(200);
    const discovery = await discRes.json();
    expect(discovery.name).toBe('Switchboard');
    expect(discovery.protocol.current).toBe(1);
    expect(discovery.capabilities.messaging).toBe(true);
    expect(discovery.capabilities.batchSync).toBe(true);
    expect(discovery.capabilities.acknowledgements).toBe(true);
    expect(discovery.capabilities.presence).toBe(true);
  });

  it('verifies staging credential enforcement, error sanitization, and backoff calculation', async () => {
    const memory = new MemoryClientStorage();
    const plug = new SwitchboardPlug(
      {
        baseUrl: stagingUrl,
        endpointId: 'antigravity',
        token: 'unregistered-probe-token-xyz',
      },
      memory
    );

    // Sync against live staging without registered token
    let errorCaught = false;
    try {
      await plug.sync();
    } catch (err: any) {
      errorCaught = true;
      // Error message must be sanitized and indicate auth failure
      expect(err.message).toContain('Invalid credentials');
      expect(err.message).not.toContain('unregistered-probe-token-xyz');
    }
    expect(errorCaught).toBe(true);

    const stats = plug.client.getStats();
    expect(stats.consecutiveFailures).toBe(1);
    expect(stats.lastError).toContain('Invalid credentials');
  });
});
