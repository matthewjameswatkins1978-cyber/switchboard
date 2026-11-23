import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SwitchboardPlug } from '../../src/plug/switchboard-plug.js';
import { MemoryClientStorage, FileClientStorage } from '../../src/client/switchboard-client.js';

describe('SwitchboardPlug Unit Tests', () => {
  let tempDir: string;
  let tempStoragePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-plug-test-'));
    tempStoragePath = path.join(tempDir, 'state-test.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('initializes with default identity and memory storage', () => {
    const memory = new MemoryClientStorage();
    const plug = new SwitchboardPlug(
      {
        endpointId: 'antigravity-test',
        projectId: 'test-project',
        storagePath: tempStoragePath,
      },
      memory
    );

    const info = plug.identify();
    expect(info.endpointId).toBe('antigravity-test');
    expect(info.projectId).toBe('test-project');
    expect(info.role).toBe('antigravity-test/plug');
    expect(info.host).toContain('Antigravity');
    expect(info.protocolVersion).toBe(1);
    expect(info.stats.outboxCount).toBe(0);
    expect(info.stats.inboxCount).toBe(0);
  });

  it('queues addressed messages with stable idempotency IDs and outbox tracking', async () => {
    const memory = new MemoryClientStorage();
    const plug = new SwitchboardPlug(
      {
        endpointId: 'antigravity',
        projectId: 'workshop',
      },
      memory
    );

    const { message } = await plug.sendMessage({
      to: 'pi',
      subject: 'Coordinate pipeline execution',
      payload: { task: 'ETL-001', steps: ['extract', 'load'] },
      kind: 'task.offer.v1',
      priority: 'normal',
    });

    expect(message.id).toBeDefined();
    expect(message.id).toContain('msg-antigravity-');
    expect(message.recipientId).toBe('pi');
    expect(message.kind).toBe('task.offer.v1');
    expect(message.subject).toBe('Coordinate pipeline execution');

    const info = plug.identify();
    expect(info.stats.outboxCount).toBe(1);

    const outbox = plug.client.getOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.message.id).toBe(message.id);
  });

  it('supports durable FileClientStorage and survives simulated restart', async () => {
    // 1. First run: queue message and save to file
    const plug1 = new SwitchboardPlug({
      endpointId: 'antigravity',
      projectId: 'workshop',
      storagePath: tempStoragePath,
    });

    await plug1.sendMessage({
      to: 'lucy',
      subject: 'Architecture review notes',
      payload: { section: 4, approved: true },
    });

    plug1.client.setStatus({ state: 'busy', description: 'Reviewing PR' });

    // Ensure state file was written
    expect(fs.existsSync(tempStoragePath)).toBe(true);

    // 2. Restart simulation: create a new plug instance pointing to same file
    const plug2 = new SwitchboardPlug({
      endpointId: 'antigravity',
      projectId: 'workshop',
      storagePath: tempStoragePath,
    });

    const info2 = plug2.identify();
    expect(info2.stats.outboxCount).toBe(1);

    const outbox2 = plug2.client.getOutbox();
    expect(outbox2[0]?.message.recipientId).toBe('lucy');
    expect(outbox2[0]?.message.subject).toBe('Architecture review notes');
  });

  it('handles progressive disclosure inbox and marks read correctly', async () => {
    const memory = new MemoryClientStorage();
    const plug = new SwitchboardPlug(
      {
        endpointId: 'antigravity',
        projectId: 'workshop',
      },
      memory
    );

    // Inject 2 incoming messages into memory storage
    memory.save({
      outbox: [],
      pendingAcks: [],
      inbox: [
        {
          id: 'msg-lucy-001',
          senderId: 'lucy',
          projectId: 'workshop',
          recipientType: 'endpoint',
          recipientId: 'antigravity',
          kind: 'task.spec.v1',
          subject: 'Review SWB-005 spec',
          payload: { specVersion: '1.0', body: 'Complete native integration' },
          priority: 'urgent',
          serverCreatedAt: 1000,
          deliverySequence: 1,
          deliveryStatus: 'STORED',
        },
        {
          id: 'msg-pi-002',
          senderId: 'pi',
          projectId: 'workshop',
          recipientType: 'endpoint',
          recipientId: 'antigravity',
          kind: 'status.v1',
          subject: 'Pi bridge operational',
          payload: { online: true },
          priority: 'normal',
          serverCreatedAt: 2000,
          deliverySequence: 2,
          deliveryStatus: 'STORED',
        },
      ],
    });

    // Re-instantiate to load state
    const plugLoaded = new SwitchboardPlug({ endpointId: 'antigravity' }, memory);

    // 1. List compact headers
    const headers = await plugLoaded.getInbox();
    expect(headers.total).toBe(2);
    expect(headers.unread).toBe(2);
    // Ordered newest first (deliverySequence 2 first)
    expect(headers.messages[0]?.id).toBe('msg-pi-002');
    expect(headers.messages[1]?.id).toBe('msg-lucy-001');

    // 2. Read first message (marks read)
    const read = plugLoaded.readMessage('msg-pi-002');
    expect(read.id).toBe('msg-pi-002');
    expect((read.payload as any).online).toBe(true);

    // 3. Verify unread count decreases
    const unreadOnly = await plugLoaded.getInbox({ unreadOnly: true });
    expect(unreadOnly.total).toBe(1);
    expect(unreadOnly.messages[0]?.id).toBe('msg-lucy-001');
    expect(plugLoaded.client.isRead('msg-pi-002')).toBe(true);
    expect(plugLoaded.client.isRead('msg-lucy-001')).toBe(false);
  });

  it('correlates replies with original message, recipient, threadId, and replyToId', async () => {
    const memory = new MemoryClientStorage();
    const plug = new SwitchboardPlug({ endpointId: 'antigravity' }, memory);

    memory.save({
      outbox: [],
      pendingAcks: [],
      inbox: [
        {
          id: 'msg-pi-42',
          senderId: 'pi',
          projectId: 'workshop',
          recipientType: 'endpoint',
          recipientId: 'antigravity',
          kind: 'question.v1',
          subject: 'Are you ready for live test?',
          payload: { testId: 'SWB-LIVE-1' },
          priority: 'normal',
          serverCreatedAt: 5000,
          deliverySequence: 10,
          deliveryStatus: 'STORED',
          threadId: 'thread-live-qualification',
        },
      ],
    });

    const plugLoaded = new SwitchboardPlug({ endpointId: 'antigravity' }, memory);

    const { message: replyMsg } = await plugLoaded.reply({
      replyToId: 'msg-pi-42',
      payload: { ready: true, host: 'Antigravity 2.29.0' },
      kind: 'answer.v1',
    });

    expect(replyMsg.recipientId).toBe('pi');
    expect(replyMsg.replyToId).toBe('msg-pi-42');
    expect(replyMsg.threadId).toBe('thread-live-qualification');
    expect(replyMsg.subject).toBe('Re: Are you ready for live test?');
    expect(replyMsg.kind).toBe('answer.v1');
    expect(replyMsg.id).toContain('rep-antigravity-');
  });

  it('queues explicit acknowledgements without duplicates', async () => {
    const memory = new MemoryClientStorage();
    const plug = new SwitchboardPlug({ endpointId: 'antigravity' }, memory);

    memory.save({
      outbox: [],
      pendingAcks: [],
      inbox: [
        {
          id: 'msg-lucy-99',
          senderId: 'lucy',
          projectId: 'workshop',
          recipientType: 'endpoint',
          recipientId: 'antigravity',
          kind: 'notice.v1',
          subject: 'Credentials provisioned',
          payload: { status: 'ok' },
          priority: 'normal',
          serverCreatedAt: 6000,
          deliverySequence: 12,
          deliveryStatus: 'STORED',
        },
      ],
    });

    const plugLoaded = new SwitchboardPlug({ endpointId: 'antigravity' }, memory);

    // Acknowledge the message
    const res = await plugLoaded.acknowledge({
      messageId: 'msg-lucy-99',
      note: 'Processed in Antigravity session',
    });

    expect(res.acknowledged).toBe(true);
    expect(plugLoaded.client.isAcknowledged('lucy', 'msg-lucy-99')).toBe(true);
    expect(plugLoaded.client.isRead('msg-lucy-99')).toBe(true);

    const pendingAcks = plugLoaded.client.getPendingAcks();
    expect(pendingAcks).toHaveLength(1);
    expect(pendingAcks[0]?.messageId).toBe('msg-lucy-99');
    expect(pendingAcks[0]?.senderId).toBe('lucy');
    expect(pendingAcks[0]?.note).toBe('Processed in Antigravity session');
  });
});
