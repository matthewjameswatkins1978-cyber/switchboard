import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { acceptsProtocol, isPausedSetting, checkReadiness, PROTOCOL_INFO } from '../../src/operations/control.ts';

test('negotiation defaults to v1 and rejects unsupported, malformed or ambiguous versions', () => {
  assert.equal(acceptsProtocol(undefined), true);
  assert.equal(acceptsProtocol('1'), true);
  for (const version of ['2','0','1, 2','01','', 'injected']) assert.equal(acceptsProtocol(version), false);
  assert.deepEqual(PROTOCOL_INFO.supported, [1]);
  assert.equal(isPausedSetting('1'), true);
  for (const setting of [undefined,'0','false','']) assert.equal(isPausedSetting(setting), false);
});

test('readiness identifies uninitialized schema, initialized empty schema and unavailable DB', async () => {
  const raw = new DatabaseSync(':memory:');
  const db = { async query(sql) { return raw.prepare(sql).all(); } };
  assert.equal(await checkReadiness(db), false);
  raw.exec('CREATE TABLE messages(id TEXT); CREATE TABLE message_deliveries(id TEXT)');
  assert.equal(await checkReadiness(db), true);
  raw.close();
  assert.equal(await checkReadiness(db), false);
});

test('readiness times out rather than hanging a monitor', async () => {
  assert.equal(await checkReadiness({ query: () => new Promise(() => {}) }, 10), false);
});
