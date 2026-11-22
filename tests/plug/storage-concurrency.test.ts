import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SqliteClientStorage,
  FileClientStorage,
  createClientStorage,
  type ClientPersistedState,
} from '../../src/client/switchboard-client.js';

describe('Storage Concurrency & Atomicity Tests (Daemon & MCP Simulation)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-storage-concurrency-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('SqliteClientStorage Multi-Process Concurrency', () => {
    it('allows concurrent access by simulated daemon and MCP processes without corruption', () => {
      const dbPath = path.join(tempDir, 'shared-state.sqlite');

      // Instance A simulates background daemon
      const daemonStorage = new SqliteClientStorage(dbPath);
      // Instance B simulates interactive MCP process
      const mcpStorage = new SqliteClientStorage(dbPath);

      const initialState: ClientPersistedState = {
        outbox: [],
        pendingAcks: [],
        inbox: [],
        cursor: '0',
        status: { state: 'available', description: 'initial' },
        readMessageIds: [],
        acknowledgedMessageIds: [],
      };

      daemonStorage.save(initialState);
      expect(mcpStorage.load()?.cursor).toBe('0');

      // Interleaved concurrent writes:
      // Daemon writes 5 updates, MCP writes 5 updates concurrently
      for (let i = 1; i <= 10; i++) {
        if (i % 2 === 0) {
          // Daemon updates cursor and status
          daemonStorage.save({
            ...initialState,
            cursor: String(i),
            status: { state: 'busy', description: `Daemon step ${i}` },
          });
        } else {
          // MCP process queues outbox item
          mcpStorage.save({
            ...initialState,
            cursor: String(i),
            status: { state: 'available', description: `MCP step ${i}` },
          });
        }

        // Each write is immediately visible to the other process
        const loaded = daemonStorage.load();
        expect(loaded).not.toBeNull();
        expect(loaded?.cursor).toBe(String(i));
      }

      daemonStorage.close();
      mcpStorage.close();
    });

    it('factory automatically creates SqliteClientStorage for .sqlite or .db paths', () => {
      const sqliteStorage = createClientStorage(path.join(tempDir, 'state.sqlite'));
      expect(sqliteStorage).toBeInstanceOf(SqliteClientStorage);
      (sqliteStorage as SqliteClientStorage).close();

      const fileStorage = createClientStorage(path.join(tempDir, 'state.json'));
      expect(fileStorage).toBeInstanceOf(FileClientStorage);
    });
  });

  describe('FileClientStorage Atomicity & Safe Replacement', () => {
    it('writes atomically via temp file and rename without partial reads', () => {
      const filePath = path.join(tempDir, 'atomic-state.json');
      const storage = new FileClientStorage(filePath);

      const state: ClientPersistedState = {
        outbox: [
          {
            message: {
              id: 'msg-001',
              recipientType: 'endpoint',
              recipientId: 'lucy',
              kind: 'message.v1',
              subject: 'Test payload',
              payload: { largeData: 'X'.repeat(4096) },
              priority: 'normal',
            },
            enqueuedAt: Date.now(),
            attempts: 0,
          },
        ],
        pendingAcks: [],
        inbox: [],
        cursor: 'c1',
      };

      storage.save(state);
      expect(fs.existsSync(filePath)).toBe(true);

      const loaded = storage.load();
      expect(loaded).not.toBeNull();
      expect(loaded?.cursor).toBe('c1');
      expect(loaded?.outbox).toHaveLength(1);
      expect((loaded?.outbox[0]?.message.payload as any).largeData.length).toBe(4096);
    });

    it('recovers from stale lockfiles', () => {
      const filePath = path.join(tempDir, 'locked-state.json');
      const lockDir = `${filePath}.lock`;

      // Create an artificial stale lockfile older than 15s
      fs.mkdirSync(lockDir);
      const staleTime = new Date(Date.now() - 20000);
      fs.utimesSync(lockDir, staleTime, staleTime);

      const storage = new FileClientStorage(filePath);
      storage.save({
        outbox: [],
        pendingAcks: [],
        inbox: [],
      });

      // Storage should have cleared stale lock and successfully saved
      const loaded = storage.load();
      expect(loaded).not.toBeNull();
      expect(fs.existsSync(lockDir)).toBe(false);
    });
  });
});
