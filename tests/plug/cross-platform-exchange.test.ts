import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { initializeSchema } from '../../src/db/schema.js';
import { AuthService } from '../../src/auth/auth-service.js';
import { SwitchboardService } from '../../src/core/service.js';
import { createSwitchboardApp } from '../../src/http/app.js';
import { SwitchboardPlug } from '../../src/plug/switchboard-plug.js';
import { FileClientStorage } from '../../src/client/switchboard-client.js';

describe('SWB-005 Cross-Platform Exchange (Pi, Antigravity, Lucy)', () => {
  let db: SqliteAdapter;
  let authService: AuthService;
  let service: SwitchboardService;
  let customFetch: typeof fetch;

  let tempDir: string;
  let agyStoragePath: string;
  let piStoragePath: string;
  let lucyStoragePath: string;

  let plugAntigravity: SwitchboardPlug;
  let plugPi: SwitchboardPlug;
  let plugLucy: SwitchboardPlug;

  const projectId = 'workshop';
  const tokenAgy = 'token-antigravity-live-secret';
  const tokenPi = 'token-pi-live-secret';
  const tokenLucy = 'token-lucy-live-secret';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-exchange-test-'));
    agyStoragePath = path.join(tempDir, 'state-antigravity.json');
    piStoragePath = path.join(tempDir, 'state-pi.json');
    lucyStoragePath = path.join(tempDir, 'state-lucy.json');

    db = new SqliteAdapter(':memory:');
    await initializeSchema(db);
    authService = new AuthService(db);
    service = new SwitchboardService(db);

    // Provision endpoints for the 3 platforms
    await authService.createProject(projectId, 'Workshop');
    await authService.registerEndpoint(projectId, 'antigravity', 'Antigravity Host', 'agent');
    await authService.registerEndpoint(projectId, 'pi', 'Pi Coordinator', 'agent');
    await authService.registerEndpoint(projectId, 'lucy', 'Lucy ChatGPT', 'agent');

    // Issue tokens
    await authService.issueToken(projectId, 'antigravity', tokenAgy, ['read', 'write']);
    await authService.issueToken(projectId, 'pi', tokenPi, ['read', 'write']);
    await authService.issueToken(projectId, 'lucy', tokenLucy, ['read', 'write']);

    const app = createSwitchboardApp({ authService, service });

    customFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      const req = new Request(u, init);
      return await app.fetch(req);
    }) as typeof fetch;

    plugAntigravity = new SwitchboardPlug(
      {
        baseUrl: 'http://localhost:3000',
        token: tokenAgy,
        endpointId: 'antigravity',
        projectId,
        storagePath: agyStoragePath,
      },
      new FileClientStorage(agyStoragePath)
    );
    // Monkey-patch fetchFn on the client instance to use in-memory bridge
    (plugAntigravity.client as any).fetchFn = customFetch;

    plugPi = new SwitchboardPlug(
      {
        baseUrl: 'http://localhost:3000',
        token: tokenPi,
        endpointId: 'pi',
        projectId,
        storagePath: piStoragePath,
      },
      new FileClientStorage(piStoragePath)
    );
    (plugPi.client as any).fetchFn = customFetch;

    plugLucy = new SwitchboardPlug(
      {
        baseUrl: 'http://localhost:3000',
        token: tokenLucy,
        endpointId: 'lucy',
        projectId,
        storagePath: lucyStoragePath,
      },
      new FileClientStorage(lucyStoragePath)
    );
    (plugLucy.client as any).fetchFn = customFetch;
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('verifies communication in all 6 directions between Pi, Antigravity, and Lucy', async () => {
    // 1. Antigravity -> Pi
    await plugAntigravity.sendMessage({
      to: 'pi',
      subject: 'AGY to PI handshake',
      payload: { hello: 'from Antigravity to Pi' },
      kind: 'handshake.v1',
    });

    // 2. Antigravity -> Lucy
    await plugAntigravity.sendMessage({
      to: 'lucy',
      subject: 'AGY to Lucy handshake',
      payload: { hello: 'from Antigravity to Lucy' },
      kind: 'handshake.v1',
    });

    // 3. Pi -> Antigravity
    await plugPi.sendMessage({
      to: 'antigravity',
      subject: 'PI to AGY task offer',
      payload: { task: 'SWB-005-IMPL' },
      kind: 'task.offer.v1',
    });

    // 4. Pi -> Lucy
    await plugPi.sendMessage({
      to: 'lucy',
      subject: 'PI to Lucy status update',
      payload: { pipeline: 'running' },
      kind: 'status.v1',
    });

    // 5. Lucy -> Antigravity
    await plugLucy.sendMessage({
      to: 'antigravity',
      subject: 'Lucy to AGY requirements',
      payload: { criteria: 'pass all tests' },
      kind: 'spec.v1',
    });

    // 6. Lucy -> Pi
    await plugLucy.sendMessage({
      to: 'pi',
      subject: 'Lucy to PI approval',
      payload: { approved: true },
      kind: 'decision.v1',
    });

    // Sync all 3 endpoints to commit outbox and receive inbound messages
    await plugAntigravity.sync();
    await plugPi.sync();
    await plugLucy.sync();

    // Now second sync cycle so each endpoint fetches messages sent by peers in round 1
    await plugAntigravity.sync();
    await plugPi.sync();
    await plugLucy.sync();

    // Check Antigravity received from Pi and Lucy
    const agyInbox = await plugAntigravity.getInbox();
    expect(agyInbox.total).toBe(2);
    const agySenders = agyInbox.messages.map((m) => m.senderId).sort();
    expect(agySenders).toEqual(['lucy', 'pi']);

    // Check Pi received from Antigravity and Lucy
    const piInbox = await plugPi.getInbox();
    expect(piInbox.total).toBe(2);
    const piSenders = piInbox.messages.map((m) => m.senderId).sort();
    expect(piSenders).toEqual(['antigravity', 'lucy']);

    // Check Lucy received from Antigravity and Pi
    const lucyInbox = await plugLucy.getInbox();
    expect(lucyInbox.total).toBe(2);
    const lucySenders = lucyInbox.messages.map((m) => m.senderId).sort();
    expect(lucySenders).toEqual(['antigravity', 'pi']);

    // All 6 directions verified!
  });

  it('verifies round-trip reply correlation and bidirectional explicit acknowledgements', async () => {
    // Lucy sends question to Antigravity
    await plugLucy.sendMessage({
      to: 'antigravity',
      subject: 'Query operational status',
      payload: { check: 'memory_usage' },
      kind: 'question.v1',
      threadId: 'thread-ops-42',
    });
    await plugLucy.sync();

    // Antigravity syncs and receives Lucy's question
    await plugAntigravity.sync();
    const agyInbox = await plugAntigravity.getInbox();
    expect(agyInbox.total).toBe(1);
    const question = agyInbox.messages[0]!;
    expect(question.senderId).toBe('lucy');
    expect(question.threadId).toBe('thread-ops-42');

    // Antigravity reads full message
    const fullQuestion = plugAntigravity.readMessage(question.id);
    expect((fullQuestion.payload as any).check).toBe('memory_usage');

    // Antigravity replies to Lucy
    await plugAntigravity.reply({
      replyToId: question.id,
      payload: { memoryMb: 128, healthy: true },
      kind: 'answer.v1',
    });

    // Antigravity acknowledges the question
    await plugAntigravity.acknowledge({
      messageId: question.id,
      note: 'Question answered',
    });

    // Antigravity syncs (flushing reply and ack)
    const agySync = await plugAntigravity.sync();
    expect(agySync.storedReceipts).toHaveLength(1); // the reply
    expect(agySync.acknowledgedReceipts).toHaveLength(1); // ack of question

    // Lucy syncs to receive reply
    const lucySync = await plugLucy.sync();
    expect(lucySync.inboundMessages).toHaveLength(1);
    const reply = lucySync.inboundMessages[0]!;

    // Verify correlation
    expect(reply.senderId).toBe('antigravity');
    expect(reply.replyToId).toBe(question.id);
    expect(reply.threadId).toBe('thread-ops-42');
    expect(reply.subject).toBe('Re: Query operational status');
    expect((reply.payload as any).healthy).toBe(true);

    // Lucy acknowledges Antigravity's reply
    await plugLucy.acknowledge({
      messageId: reply.id,
      note: 'Received and verified answer',
    });
    const lucyAckSync = await plugLucy.sync();
    expect(lucyAckSync.acknowledgedReceipts).toHaveLength(1);

    // Antigravity syncs to receive confirmation
    await plugAntigravity.sync();
    expect(plugAntigravity.client.getOutbox()).toHaveLength(0);
    expect(plugAntigravity.client.getPendingAcks()).toHaveLength(0);
  });

  it('guarantees no lost or duplicate messages following abrupt restart and resume', async () => {
    // 1. Antigravity queues 2 messages, syncs to store them
    await plugAntigravity.sendMessage({
      to: 'pi',
      subject: 'Task 1: Pre-restart send',
      payload: { item: 1 },
      id: 'agy-stable-msg-1',
    });
    await plugAntigravity.sendMessage({
      to: 'lucy',
      subject: 'Task 2: Pre-restart send',
      payload: { item: 2 },
      id: 'agy-stable-msg-2',
    });

    await plugAntigravity.sync();
    expect(plugAntigravity.client.getOutbox()).toHaveLength(0);

    // 2. Pi sends a message to Antigravity
    await plugPi.sendMessage({
      to: 'antigravity',
      subject: 'Inbound message while alive',
      payload: { dispatch: 'A' },
      id: 'pi-msg-before-restart',
    });
    await plugPi.sync();

    // 3. Antigravity syncs and receives Pi's message
    await plugAntigravity.sync();
    const agyInboxBefore = await plugAntigravity.getInbox();
    expect(agyInboxBefore.total).toBe(1);

    // Antigravity queues an un-synced message right before "crashing"
    await plugAntigravity.sendMessage({
      to: 'lucy',
      subject: 'Queued unsent message',
      payload: { item: 3 },
      id: 'agy-unflushed-msg-3',
    });
    // Do not sync yet! File storage should contain this unsent message

    // Verify file storage exists on disk
    expect(fs.existsSync(agyStoragePath)).toBe(true);

    // 4. ABRUPT RESTART: Destroy in-memory plugAntigravity, re-create from disk
    const restartedPlug = new SwitchboardPlug(
      {
        baseUrl: 'http://localhost:3000',
        token: tokenAgy,
        endpointId: 'antigravity',
        projectId,
        storagePath: agyStoragePath,
      },
      new FileClientStorage(agyStoragePath)
    );
    (restartedPlug.client as any).fetchFn = customFetch;

    // Verify state restored
    const restoredStats = restartedPlug.identify().stats;
    expect(restoredStats.inboxCount).toBe(1);
    expect(restoredStats.outboxCount).toBe(1); // unflushed message preserved!

    // Pi sends a second message while Antigravity was restarting
    await plugPi.sendMessage({
      to: 'antigravity',
      subject: 'Message during restart',
      payload: { dispatch: 'B' },
      id: 'pi-msg-after-restart',
    });
    await plugPi.sync();

    // 5. Restarted Antigravity resumes sync
    const resumeSync = await restartedPlug.sync();
    // It should have flushed the queued unsent message
    expect(resumeSync.storedReceipts).toHaveLength(1);
    expect(resumeSync.storedReceipts[0]?.messageId).toBe('agy-unflushed-msg-3');
    // And received only the NEW message from Pi (pi-msg-after-restart)
    expect(resumeSync.inboundMessages).toHaveLength(1);
    expect(resumeSync.inboundMessages[0]?.id).toBe('pi-msg-after-restart');

    // Total inbox should now have exactly 2 messages (pi-msg-before-restart and pi-msg-after-restart)
    const totalInbox = await restartedPlug.getInbox();
    expect(totalInbox.total).toBe(2);
    expect(totalInbox.messages.map((m) => m.id).sort()).toEqual([
      'pi-msg-after-restart',
      'pi-msg-before-restart',
    ]);

    // Lucy verifies she received agy-unflushed-msg-3 without duplicates
    await plugLucy.sync();
    const lucyInbox = await plugLucy.getInbox();
    const lucyAgyMsgs = lucyInbox.messages.filter((m) => m.senderId === 'antigravity');
    expect(lucyAgyMsgs.map((m) => m.id).sort()).toEqual([
      'agy-stable-msg-2',
      'agy-unflushed-msg-3',
    ]);
  });

  it('updates operational presence and discovers peers across the workshop', async () => {
    // 1. Antigravity updates presence to busy
    await plugAntigravity.updateStatus({
      state: 'busy',
      description: 'Running SWB-005 qualification tests',
      immediate: true,
    });

    // 2. Pi updates presence to waiting
    await plugPi.updateStatus({
      state: 'waiting',
      description: 'Awaiting coordination response',
      immediate: true,
    });

    // 3. Lucy discovers all endpoints
    const endpoints = await plugLucy.listEndpoints();
    expect(endpoints).toHaveLength(3);

    const agyEndpoint = endpoints.find((e) => e.endpointId === 'antigravity');
    expect(agyEndpoint?.state).toBe('busy');
    expect(agyEndpoint?.description).toBe('Running SWB-005 qualification tests');

    const piEndpoint = endpoints.find((e) => e.endpointId === 'pi');
    expect(piEndpoint?.state).toBe('waiting');
    expect(piEndpoint?.description).toBe('Awaiting coordination response');

    // 4. Lucy inspects board overview
    const board = await plugLucy.getBoard();
    expect(board.endpoints).toHaveLength(3);
    expect(board.projectId).toBe(projectId);
  });
});
