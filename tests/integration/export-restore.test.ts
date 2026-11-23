import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';

describe('Data Export, Manifest Checksum, and Restoration Verification', () => {
  let sourceDb: SqliteAdapter;
  let sourceAuth: AuthService;
  let sourceService: SwitchboardService;

  const projectId = 'proj-export-test';
  const token = 'tok-export-admin';

  beforeEach(async () => {
    sourceDb = new SqliteAdapter(':memory:');
    await initializeSchema(sourceDb);
    sourceAuth = new AuthService(sourceDb);
    sourceService = new SwitchboardService(sourceDb);

    await sourceAuth.createProject(projectId, 'Export Test Project');
    await sourceAuth.registerEndpoint(projectId, 'admin-1', 'Admin 1', 'admin');
    await sourceAuth.registerEndpoint(projectId, 'worker-1', 'Worker 1', 'agent');
    await sourceAuth.registerEndpoint(projectId, 'worker-2', 'Worker 2', 'agent');

    await sourceAuth.issueToken(projectId, 'admin-1', token, ['read', 'write', 'admin']);
  });

  it('exports populated project with SHA-256 checksum and restores into fresh database with exact fidelity', async () => {
    const principalAdmin = await sourceAuth.authenticate(`Bearer ${token}`);
    const principalWorker1 = {
      endpointId: 'worker-1',
      projectId,
      scopes: ['read', 'write'],
      role: 'agent' as const,
    };
    const principalWorker2 = {
      endpointId: 'worker-2',
      projectId,
      scopes: ['read', 'write'],
      role: 'agent' as const,
    };

    // Populate data
    await sourceService.createChannel(principalAdmin, 'chan-ops', 'Operations', [
      'admin-1',
      'worker-1',
      'worker-2',
    ]);

    // Worker 1 sends message to Worker 2
    await sourceService.sendMessage(principalWorker1, {
      id: 'job-msg-01',
      recipientType: 'endpoint',
      recipientId: 'worker-2',
      kind: 'job.dispatch.v1',
      subject: 'Process batch',
      payload: { batchSize: 50 },
      priority: 'urgent',
    });

    // Worker 2 syncs and acknowledges
    const syncRes2 = await sourceService.sync(principalWorker2, { limit: 10 });
    expect(syncRes2.inboundMessages).toHaveLength(1);
    await sourceService.acknowledge(principalWorker2, [
      { messageId: 'job-msg-01', senderId: 'worker-1', note: 'Completed' },
    ]);

    // Admin updates status
    await sourceService.updateStatus(principalAdmin, {
      state: 'busy',
      description: 'System maintenance',
    });

    // 1. Export project data
    const exportData = await sourceService.exportData(principalAdmin);
    expect(exportData.version).toBe('0.1.0');
    expect(exportData.projectId).toBe(projectId);
    expect(exportData.checksumSha256).toBeTruthy();
    expect(exportData.messages).toHaveLength(1);
    expect(exportData.deliveries).toHaveLength(1);
    expect(exportData.deliveries[0]?.status).toBe('ACKNOWLEDGED');

    // 2. Verify tampering / corruption detection
    const corruptedData = JSON.parse(JSON.stringify(exportData));
    corruptedData.messages[0].subject = 'Tampered Subject';
    await expect(sourceService.importData(principalAdmin, corruptedData)).rejects.toThrowError(
      /checksum mismatch/
    );

    // 3. Create fresh target database and restore
    const targetDb = new SqliteAdapter(':memory:');
    await initializeSchema(targetDb);
    const targetAuth = new AuthService(targetDb);
    const targetService = new SwitchboardService(targetDb);

    const importRes = await targetService.importData(principalAdmin, exportData);
    expect(importRes.importedCount).toBe(1);

    // 4. Verify restored state matches original source exactly
    const restoredEndpoints = await targetService.listEndpoints(principalAdmin);
    expect(restoredEndpoints.map((e) => e.endpointId)).toEqual(['admin-1', 'worker-1', 'worker-2']);

    const restoredMsg = await targetService.getMessage(principalWorker2, 'job-msg-01');
    expect(restoredMsg.id).toBe('job-msg-01');
    expect(restoredMsg.senderId).toBe('worker-1');
    expect(restoredMsg.subject).toBe('Process batch');
    expect(restoredMsg.priority).toBe('urgent');
    expect(restoredMsg.deliveryStatus).toBe('ACKNOWLEDGED');
    expect((restoredMsg.payload as any).batchSize).toBe(50);

    const restoredStatus = await targetService.getStatus(principalAdmin, 'admin-1');
    expect(restoredStatus.state).toBe('busy');
    expect(restoredStatus.description).toBe('System maintenance');
  });
});
