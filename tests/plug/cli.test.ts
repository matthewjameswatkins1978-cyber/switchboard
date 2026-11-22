import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../../src/plug/cli.js';

describe('Switchboard Plug CLI Tests', () => {
  let tempDir: string;
  let tempStoragePath: string;
  let logs: string[] = [];
  let originalLog: typeof console.log;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cli-test-'));
    tempStoragePath = path.join(tempDir, 'state-cli.json');
    logs = [];
    originalLog = console.log;
    console.log = (...args: any[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    originalEnv = { ...process.env };
    process.env.SWITCHBOARD_STORAGE_PATH = tempStoragePath;
    process.env.SWITCHBOARD_ENDPOINT_ID = 'cli-test-endpoint';
  });

  afterEach(() => {
    console.log = originalLog;
    process.env = originalEnv;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('runs identify command and outputs valid json', async () => {
    await runCli(['identify']);
    expect(logs.length).toBeGreaterThan(0);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.endpointId).toBe('cli-test-endpoint');
    expect(parsed.role).toBe('cli-test-endpoint/plug');
    expect(parsed.stats.inboxCount).toBe(0);
  });

  it('runs send and inbox commands with local state persistence', async () => {
    await runCli([
      'send',
      '--to',
      'target-agent',
      '--subject',
      'CLI test message',
      '--payload',
      '{"status":"ok"}',
    ]);

    expect(logs.length).toBeGreaterThan(0);
    const sendOutput = JSON.parse(logs[0]!);
    expect(sendOutput.message.recipientId).toBe('target-agent');
    expect(sendOutput.message.subject).toBe('CLI test message');

    // State file was created
    expect(fs.existsSync(tempStoragePath)).toBe(true);

    // Query inbox
    logs = [];
    await runCli(['inbox']);
    const inboxOutput = JSON.parse(logs[0]!);
    expect(inboxOutput.total).toBe(0);
  });

  it('runs config show command and redacts token while providing SHA-256 hash', async () => {
    process.env.SWITCHBOARD_TOKEN = 'secret-test-token-123456';
    await runCli(['config', 'show']);
    const configOutput = JSON.parse(logs[0]!);
    expect(configOutput.endpointId).toBe('cli-test-endpoint');
    expect(configOutput.token).toBe('[REDACTED: 256-bit credential present]');
    expect(configOutput.tokenSha256).toBeDefined();
    expect(configOutput.tokenSha256.length).toBe(64);
  });
});
