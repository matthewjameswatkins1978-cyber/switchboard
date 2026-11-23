#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const generationPattern = /^\d{13}-[a-f0-9-]{36}\.sql$/;
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const requiredTables = [
  'projects', 'credentials', 'messages', 'message_deliveries', 'archived_messages',
  'archived_deliveries', 'endpoint_sequences',
];

function verify(file, maxBytes, expectedChecksum, restorePath) {
  const size = statSync(file).size;
  if (!size || size > maxBytes) throw new Error('Artifact exceeds the configured size limit');
  const bytes = readFileSync(file);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  if (expectedChecksum !== undefined && checksum !== expectedChecksum) {
    throw new Error('Previously committed artifact failed checksum verification');
  }
  if (restorePath) closeSync(openSync(restorePath, 'wx', 0o600));
  const db = new DatabaseSync(restorePath ?? ':memory:', { enableForeignKeyConstraints: false });
  try {
    db.exec(bytes.toString('utf8'));
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name));
    if (!requiredTables.every(table => tables.has(table))
      || db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').get()) {
      throw new Error('Isolated restore verification failed');
    }
    return checksum;
  } finally {
    db.close();
  }
}

function atomicWrite(path, contents) {
  const temp = path + '.pending';
  writeFileSync(temp, contents, { mode: 0o600, flush: true });
  renameSync(temp, path);
}

function backup(directory, config, database, mode, maxBytes) {
  const lock = join(directory, '.backup-lock');
  mkdirSync(lock, { mode: 0o700 });
  const statusPath = join(directory, 'status.json');
  const generation = Date.now() + '-' + randomUUID() + '.sql';
  const pending = join(directory, '.export.pending');
  const startedAt = new Date().toISOString();
  let previous = {};
  let phase = 'retention';
  try {
    try {
      previous = JSON.parse(readFileSync(statusPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // Commit records name the SQL artifact and store its expected checksum.
    // An interrupted publication may leave an uncommitted artifact.
    const files = readdirSync(directory);
    const verified = [];
    for (const file of files.filter(name => generationPattern.test(name)).sort().reverse()) {
      const path = join(directory, file);
      const manifest = path + '.sha256';
      if (!files.includes(file + '.sha256')) {
        unlinkSync(path);
        continue;
      }
      if (verified.length === 2) {
        unlinkSync(manifest);
        unlinkSync(path);
        continue;
      }
      verify(path, maxBytes, readFileSync(manifest, 'utf8').trim());
      verified.push(file);
    }
    for (const file of files.filter(name => name.endsWith('.sql.sha256') && generationPattern.test(name.slice(0, -7)))) {
      if (!files.includes(file.slice(0, -7))) unlinkSync(join(directory, file));
    }

    phase = 'export';
    if (files.includes('.export.pending')) unlinkSync(pending);
    const result = spawnSync(process.execPath, [
      wrangler, 'd1', 'export', database, mode, '--config', config, '--output', pending,
      '--skip-confirmation',
    ], {
      timeout: 120_000,
      killSignal: 'SIGKILL',
      stdio: 'ignore',
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    });
    if (result.status !== 0) throw new Error('Wrangler export failed or timed out');

    phase = 'restore';
    const checksum = verify(pending, maxBytes);
    const artifact = join(directory, generation);
    const descriptor = openSync(pending, 'r+');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(pending, artifact);
    atomicWrite(artifact + '.sha256', checksum + '\n');

    phase = 'retention';
    const expired = verified.at(-1);
    if (verified.length === 2) {
      unlinkSync(join(directory, expired + '.sha256'));
      unlinkSync(join(directory, expired));
    }
    atomicWrite(statusPath, JSON.stringify({
      lastAttempt: startedAt, lastSuccess: new Date().toISOString(), artifact: generation,
      lastFailure: previous.lastFailure ?? null, checksum,
    }, null, 2) + '\n');
    console.log('Backup and isolated restore verified.');
  } catch {
    atomicWrite(statusPath, JSON.stringify({
      ...previous, lastAttempt: startedAt, lastFailure: { at: new Date().toISOString(), phase },
    }, null, 2) + '\n');
    console.error('Switchboard backup failed during ' + phase + '. See status.json.');
    process.exitCode = 1;
  } finally {
    try {
      unlinkSync(pending);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally {
      rmdirSync(lock);
    }
  }
}

const [mode, ...args] = process.argv.slice(2);
const isRestore = mode === '--restore';
const requiredArgs = isRestore ? 2 : 3;
const maxBytes = Number(args[requiredArgs] ?? '67108864');
if (!(isRestore || mode === '--local' || mode === '--remote')
  || args.length < requiredArgs || args.length > requiredArgs + 1
  || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 536870912) {
  console.error('Usage: node bin/sb-d1-backup.js --local|--remote CONFIG DATABASE EXISTING_PRIVATE_DIRECTORY [MAX_BYTES]');
  console.error('       node bin/sb-d1-backup.js --restore ARTIFACT.sql NEW_ISOLATED.sqlite [MAX_BYTES]');
  process.exitCode = 2;
} else {
  try {
    process.umask(0o077);
    if (isRestore) {
      const [artifact, target] = args;
      const expected = readFileSync(artifact + '.sha256', 'utf8').trim();
      verify(artifact, maxBytes, expected, target);
      console.log('Checksum and isolated SQLite restore verified.');
    } else {
      const [config, database, directory] = args;
      backup(resolve(directory), resolve(config), database, mode, maxBytes);
    }
  } catch {
    console.error(isRestore
      ? 'Restore failed. Check the artifact, checksum, and whether the isolated target already exists.'
      : 'Backup could not start or clean up. Check the private directory and backup lock.');
    process.exitCode = 1;
  }
}
