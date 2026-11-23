import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Telemetry, SIGNALS, observeFetch } from '../../src/telemetry/adapter.ts';
import { JsonlTransport } from '../../src/telemetry/jsonl.ts';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-telemetry-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('all four kinds, monotonic sequences, fixed schema and no sensitive fields', async t => {
  const dir = await fixture(t);
  const transport = new JsonlTransport(dir);
  const telemetry = new Telemetry(transport);
  const secret = 'test-private-message-token';
  telemetry.emit('session.started');
  const wrapped = observeFetch(telemetry, async () => new Response(secret, { status: 403 }));
  const response = await wrapped(new Request(`https://example.invalid/${secret}`, { headers: { Authorization: secret } }));
  assert.equal(await response.text(), secret);
  telemetry.emit('not-permitted', 1);
  telemetry.emit('request.duration', NaN);
  telemetry.emit('session.stopped');
  await telemetry.close();
  const raw = await readFile(transport.filename, 'utf8');
  assert.ok(!raw.includes(secret));
  const records = raw.trim().split('\n').map(JSON.parse);
  assert.deepEqual(new Set(records.map(x=>x.kind)), new Set(['event','measurement','counter','gauge']));
  assert.deepEqual(records.map(x=>x.seq), records.map((_,i)=>i+1));
  for (const r of records) {
    assert.deepEqual(Object.keys(r).sort(), ['kind','name','observed_at','seq','unit','v','value']);
    assert.equal(r.v, 1);
    assert.equal(r.kind, SIGNALS[r.name].kind);
    assert.equal(r.unit, SIGNALS[r.name].unit);
    assert.ok(Number.isFinite(r.value));
    assert.ok(Number.isFinite(Date.parse(r.observed_at)));
  }
  assert.equal(records.filter(r=>r.name==='request.failed').length, 1);
  assert.equal(records.findLast(r=>r.name==='request.inflight').value, 0);
});

test('separate runs, bounded queues and bounded file size', async t => {
  const dir = await fixture(t);
  const a = new JsonlTransport(dir, { maxBytes: 600, maxPending: 2 });
  const b = new JsonlTransport(dir);
  const ta = new Telemetry(a), tb = new Telemetry(b);
  for (let i=0;i<1000;i++) ta.emit('request.completed');
  tb.emit('session.started');
  await Promise.all([ta.close(), tb.close()]);
  assert.notEqual(a.filename, b.filename);
  assert.equal((await readdir(dir)).length, 2);
  assert.ok((await stat(a.filename)).size <= 600);
  assert.equal((await readFile(a.filename, 'utf8')).trim().split('\n').length, 2);
  ta.emit('request.completed');
  await ta.close();
  assert.equal((await readFile(a.filename, 'utf8')).trim().split('\n').length, 2);
});

test('file byte cap applies independently of queue capacity', async t => {
  const dir = await fixture(t);
  const transport = new JsonlTransport(dir, { maxBytes: 500 });
  const telemetry = new Telemetry(transport);
  for (let i=0;i<100;i++) telemetry.emit('request.completed');
  await telemetry.close();
  const raw = await readFile(transport.filename, 'utf8');
  const records = raw.trim().split('\n').map(JSON.parse);
  assert.ok(Buffer.byteLength(raw) <= 500);
  assert.ok(records.length > 1 && records.length < 5);
});

test('disabled/unused transport creates no file; invalid path and throwing transport do not affect requests', async t => {
  const dir = await fixture(t);
  const unused = new JsonlTransport(dir);
  await unused.close();
  assert.deepEqual(await readdir(dir), []);
  const blocked = join(dir, 'file-not-directory');
  await writeFile(blocked, 'blocked');
  const telemetry = new Telemetry(new JsonlTransport(blocked));
  const bad = new Telemetry({ offer(){ throw new Error('unavailable'); }, async close(){ throw new Error('unavailable'); } });
  for (const observer of [telemetry, bad]) {
    const fn = observeFetch(observer, () => new Response('ok'));
    assert.equal(await (await fn()).text(), 'ok');
    const err = new Error('original');
    await assert.rejects(observeFetch(observer, () => { throw err; })(), e=>e===err);
    await observer.close();
  }
  assert.equal(await readFile(blocked, 'utf8'), 'blocked');
});

test('manifest matches all permitted signals', async () => {
  const manifest = await readFile(new URL('../../oracle.toml', import.meta.url), 'utf8');
  assert.match(manifest, /enabled_by_default = false/);
  const entries = [...manifest.matchAll(/\[\[signals\]\]\s+name = "([^"]+)"\s+kind = "([^"]+)"\s+unit = "([^"]+)"/g)];
  assert.deepEqual(Object.fromEntries(entries.map(([,name,kind,unit])=>[name,{kind,unit}])), SIGNALS);
});
