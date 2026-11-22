import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { it, expect } from 'vitest';
import { createCodexPlug } from '../../src/mcp/codex-plug.js';
import { startServer } from '../../src/server/node-server.js';

it('replays a committed send after response loss, persists inbox and acks, and gates idle polling', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'switchboard-codex-'));
  const service = await startServer({
    port: 0, host: '127.0.0.1', databasePath: join(directory, 'server.db'), housekeepingIntervalMs: 0,
  });
  if (!service.server.listening) {
    await new Promise<void>((resolve, reject) => service.server.once('listening', resolve).once('error', reject));
  }
  const address = service.server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const origin = 'http://127.0.0.1:' + address.port;
  let clock = Date.now();
  let loseResponse = true;
  const peers: Array<Awaited<ReturnType<typeof connect>>> = [];
  async function connect(endpoint: string, intercept = false) {
    const plug = createCodexPlug({
      origin, endpoint, token: 'fixture-' + endpoint, mailbox: join(directory, endpoint + '.db'),
      now: () => clock,
      fetch: intercept ? async (...args) => {
        const response = await fetch(...args);
        if (loseResponse) {
          loseResponse = false;
          await response.text();
          throw new Error('Fixture lost committed response');
        }
        return response;
      } : undefined,
    });
    const mcp = new Client({ name: 'fixture', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await plug.server.connect(serverTransport);
    await mcp.connect(clientTransport);
    let open = true;
    const peer = {
      call: async (name: string, args: Record<string, unknown> = {}) => {
        const response = await mcp.callTool({ name, arguments: args });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        return response.structuredContent;
      },
      close: async () => {
        if (!open) return;
        open = false;
        await mcp.close();
        await plug.server.close();
        plug.close();
      },
    };
    peers.push(peer);
    return peer;
  }

  try {
    for (const id of ['alpha', 'beta']) {
      await service.authService.registerEndpoint('default', id, id, 'agent');
      await service.authService.issueToken('default', id, 'fixture-' + id, ['read', 'write']);
    }
    let alpha = await connect('alpha', true);
    let beta = await connect('beta');
    const message = { id: 'hello', recipientType: 'endpoint', recipientId: 'beta',
      kind: 'test.v1', subject: 'Hello', payload: { fixture: true }, threadId: 'thread' };
    await alpha.call('queue_message', message);
    expect(await alpha.call('sync')).toMatchObject({ outcome: 'failed', pending: { outgoing: 1 } });
    await alpha.close();
    clock += 150000;
    alpha = await connect('alpha', true);
    expect(await alpha.call('sync')).toMatchObject({ stored: [{ messageId: 'hello', isDuplicate: true }] });
    expect(await alpha.call('sync')).toMatchObject({ outcome: 'deferred' });
    expect(await alpha.call('status')).toMatchObject({ requests: 2 });
    await beta.call('sync');
    await beta.call('queue_ack', { senderId: 'alpha', messageId: 'hello' });
    await beta.call('queue_message', { ...message, id: 'reply', recipientId: 'alpha', replyToId: 'hello' });
    await beta.close();
    beta = await connect('beta');
    expect(await beta.call('inbox')).toMatchObject({ messages: [{ id: 'hello' }] });
    expect(await beta.call('sync')).toMatchObject({
      stored: [{ messageId: 'reply' }], acknowledged: [{ messageId: 'hello' }],
    });
    clock += 150000;
    await alpha.call('sync');
    expect(await alpha.call('inbox')).toMatchObject({
      messages: [{ id: 'reply', threadId: 'thread', replyToId: 'hello' }],
    });
    expect(await beta.call('inbox')).toMatchObject({ messages: [] });
    const betaHistory = await beta.call('inbox', { includeAcknowledged: true });
    expect(betaHistory).toMatchObject({ messages: [{ id: 'hello', acknowledged: true }] });
    expect(betaHistory?.messages).toHaveLength(1);
  } finally {
    for (const peer of peers) await peer.close();
    await new Promise<void>((resolve, reject) => service.server.close(error => error ? reject(error) : resolve()));
    service.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
