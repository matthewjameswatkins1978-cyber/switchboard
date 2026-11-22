import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/auth-service.js';
import { D1Adapter } from '../../src/db/d1-adapter.js';


const origin = 'https://switchboard.example';
const resource = origin + '/mcp/chatgpt';
const redirect = 'https://client.example/callback';
const owner = randomBytes(32).toString('hex');
const bearer = randomBytes(32).toString('hex');
const digest = (s: string) => createHash('sha256').update(s);
const temporary = mkdtempSync(join(tmpdir(), 'switchboard-oauth-'));
let runtime: Miniflare;
const serverLogs: string[] = [];
const request = (path: string, init?: RequestInit) => runtime.dispatchFetch(origin + path, init);
const form = (fields: Record<string, string>, headers?: Record<string, string>) => ({
  method: 'POST',
  redirect: 'manual' as const,
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(fields),
});

beforeAll(async () => {
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run',
    '--outdir', temporary], { stdio: 'pipe' });
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    handleStructuredLogs: (event) => serverLogs.push(JSON.stringify(event)),
    scriptPath: join(temporary, 'worker.js'),
    compatibilityDate: '2024-11-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    d1Persist: join(temporary, 'd1'),
    kvNamespaces: ['OAUTH_KV'],
    ratelimits: { CHATGPT_OAUTH_LIMIT: { namespace_id: '106', simple: { limit: 60, period: 60 } } },
    kvPersist: join(temporary, 'kv'),
    bindings: {
      CHATGPT_OAUTH_ORIGIN: origin,
      CHATGPT_OAUTH_PROJECT: 'fictional-workshop',
      CHATGPT_OAUTH_REDIRECTS: redirect,
      CHATGPT_OAUTH_OWNER_HASH: digest(owner).digest('hex'),
    },
  }));
  const d1 = await runtime.getD1Database('DB');
  const migration = readFileSync('src/db/migrations/0001_initial_schema.sql', 'utf8');
  await d1.batch(migration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => d1.prepare(sql)));
  const db = new D1Adapter(d1);
  const auth = new AuthService(db);
  await auth.registerEndpoint('fictional-workshop', 'lucy-chat', 'Lucy');
  await auth.registerEndpoint('fictional-workshop', 'fictional-peer', 'Peer');
  await auth.registerEndpoint('other-workshop', 'other-agent', 'Other');
  await auth.issueToken('fictional-workshop', 'fictional-peer', bearer);
});

afterAll(async () => {
  await runtime?.dispose();
  rmSync(temporary, { recursive: true, force: true });
});

it('qualifies OAuth discovery, approval, isolation, messaging and revocation in Workers', async () => {
  const anonymous = await request('/mcp/chatgpt');
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp/chatgpt');
  for (const token of [bearer, 'invalid']) {
    expect((await request('/mcp/chatgpt', { headers: { Authorization: 'Bearer ' + token } })).status).toBe(401);
  }
  const metadata = await (await request('/.well-known/oauth-protected-resource/mcp/chatgpt')).json();
  expect(metadata).toMatchObject({ resource, authorization_servers: [origin] });
  const issuer = await (await request('/.well-known/oauth-authorization-server')).json();
  expect(issuer).toMatchObject({ issuer: origin, code_challenge_methods_supported: ['S256'] });
  const path = (url: string) => new URL(url).pathname;
  const register = (uri: string) => request(path(issuer.registration_endpoint), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: 'none' }),
  });
  expect((await register('https://other.example/callback')).status).toBe(400);
  const registration = await register(redirect);
  expect(registration.status).toBe(201);
  const { client_id } = await registration.json();
  const verifier = randomBytes(48).toString('base64url');
  const authorize = (override: Record<string, string> = {}) => request(path(issuer.authorization_endpoint) + '?' +
    new URLSearchParams({
      client_id, redirect_uri: redirect, resource, response_type: 'code', scope: 'switchboard',
      code_challenge_method: 'S256', code_challenge: digest(verifier).digest('base64url'),
      state: 'fixture', agent_id: 'other-agent', ...override,
    }));
  for (const override of [{ resource: origin + '/mcp' }, { scope: 'admin' }, { code_challenge_method: 'plain' }]) {
    expect((await authorize(override)).status).toBe(400);
  }
  const consent = await authorize();
  expect(consent.status).toBe(200);
  expect(consent.headers.get('Referrer-Policy')).toBe('strict-origin');
  const cookie = consent.headers.get('set-cookie')!.split(';')[0];
  const handle = decodeURIComponent((await consent.text()).match(/name="handle" value="([^"]+)"/)![1]);
  const approve = (secret: string, binding: string, requestOrigin = origin) =>
    request(path(issuer.authorization_endpoint),
      form({ handle, owner: secret, agent_id: 'other-agent' }, { Cookie: binding, Origin: requestOrigin }));
  expect((await approve(owner, cookie, 'null')).status).toBe(403);
  expect((await approve(owner, cookie, 'https://other.example')).status).toBe(403);
  expect((await approve('wrong', cookie)).status).toBe(403);
  expect((await approve(owner, '')).status).toBe(400);
  const approval = await approve(owner, cookie);
  expect(approval.status).toBe(303);
  expect((await approve(owner, cookie)).status).toBe(400);
  const callback = new URL(approval.headers.get('location')!);
  expect(callback.searchParams.get('state')).toBe('fixture');
  expect(callback.searchParams.get('iss')).toBe(origin);
  const code = callback.searchParams.get('code')!;
  const exchange = (override: Record<string, string> = {}) => request(path(issuer.token_endpoint),
    form({ grant_type: 'authorization_code', client_id, redirect_uri: redirect, code,
      code_verifier: verifier, resource, ...override }));
  expect((await exchange({ code_verifier: randomBytes(48).toString('base64url') })).status).toBe(400);
  expect((await exchange({ resource: origin + '/mcp' })).status).toBe(400);
  const token = await exchange();
  expect(token.status).toBe(200);
  const { access_token, refresh_token, expires_in } = await token.json();
  expect(expires_in).toBe(600);
  expect((await request('/mcp', { headers: { Authorization: 'Bearer ' + access_token } })).status).toBe(401);

  const connect = async (url: string, token: string) => {
    const client = new Client({ name: 'fictional-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      fetch: ((input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', 'Bearer ' + token);
        return runtime.dispatchFetch(String(input), { ...init, headers: Object.fromEntries(headers) });
      }) as typeof fetch,
    }));
    return client;
  };
  const lucy = await connect(resource, access_token);
  const peer = await connect(origin + '/mcp', bearer);
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    if (client === lucy) {
      const id = result._meta?.['switchboard/receipt'];
      expect(id).toMatch(/^[\da-f-]{36}$/);
      expect(result.content).toContainEqual({ type: 'text', text: 'Switchboard receipt ' + id });
      await expect.poll(() => serverLogs.some(log =>
        log.includes('switchboard.oauth.tool') && log.includes(name) && log.includes(String(id)),
      )).toBe(true);
      if (process.env.SWB_PRINT_TEST_RECEIPTS === '1') {
        console.info(name + ' receipt ' + String(id).slice(0, 8) + ' [redacted], matched server event');
      }
    }
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  try {
    const tools = (await lucy.listTools()).tools.map(t => t.name);
    expect(tools).toContain('get_inbox');
    expect(tools).not.toContain('rotate_credential');
    expect((await peer.listTools()).tools.map(t => t.name)).toContain('rotate_credential');
    await call(lucy, 'get_status', { endpoint_id: 'lucy-chat' });
    const endpoints = await call(lucy, 'list_endpoints', {});
    expect(JSON.stringify(endpoints)).toContain('fictional-peer');
    expect(JSON.stringify(endpoints)).not.toContain('other-agent');
    const message = { id: 'fictional-message', recipient_type: 'endpoint', recipient_id: 'fictional-peer',
      kind: 'test.oauth.v1', subject: 'Fictional', payload: '{}' };
    const receipt = await call(lucy, 'send_message', message);
    expect(receipt).toMatchObject({ messageId: message.id });
    const incoming = await call(peer, 'get_inbox', {});
    expect(JSON.stringify(incoming)).toContain('lucy-chat');
    await call(peer, 'acknowledge', { message_id: message.id, sender_id: 'lucy-chat' });
    await call(peer, 'send_message', { ...message, id: 'fictional-reply', recipient_id: 'lucy-chat' });
    const reply = await call(lucy, 'get_inbox', {});
    expect(JSON.stringify(reply)).toContain('fictional-reply');
    await call(lucy, 'acknowledge', { message_id: 'fictional-reply', sender_id: 'fictional-peer' });
  } finally {
    await lucy.close();
    await peer.close();
  }
  const refresh = (extra: Record<string, string> = {}) => request(path(issuer.token_endpoint),
    form({ grant_type: 'refresh_token', refresh_token, client_id, resource, ...extra }));
  const kv = await runtime.getKVNamespace('OAUTH_KV');
  const [userId, grantId] = access_token.split(':');
  const key = ['token', userId, grantId, digest(access_token).digest('hex')].join(':');
  const active = await kv.get(key, 'json') as { expiresAt: number; audience: string };
  const verifyToken = () => request('/mcp/chatgpt', {
    headers: { Authorization: 'Bearer ' + access_token },
  });
  for (const override of [{ expiresAt: 1 }, { audience: origin + '/mcp' }]) {
    await kv.put(key, JSON.stringify({ ...active, ...override }));
    expect((await verifyToken()).status).toBe(401);
  }
  await kv.put(key, JSON.stringify(active));
  expect((await refresh({ scope: 'admin' })).status).toBe(400);
  const refreshed = await refresh();
  expect(refreshed.status).toBe(200);
  const replacement = await refreshed.json();
  expect(replacement.scope).toBe('switchboard');
  expect(replacement.refresh_token).not.toBe(refresh_token);
  const refreshedClient = await connect(resource, replacement.access_token);
  await refreshedClient.close();
  const revoke = await request(path(issuer.revocation_endpoint),
    form({ token: replacement.refresh_token, client_id }));
  expect(revoke.status).toBe(200);
  expect((await refresh({ refresh_token: replacement.refresh_token })).status).toBe(400);
  for (const token of [access_token, replacement.access_token]) {
    expect((await request('/mcp/chatgpt', { headers: { Authorization: 'Bearer ' + token } })).status).toBe(401);
  }
  const auditLogs = serverLogs.filter(log => log.includes('switchboard.oauth.tool')).join(' ');
  for (const privateValue of [owner, bearer, access_token, replacement.access_token, 'fictional-reply']) {
    expect(auditLogs.includes(privateValue)).toBe(false);
  }
  let throttled = false;
  for (let attempt = 0; attempt < 62; attempt++) {
    const response = await register('https://other.example/callback');
    if (response.status === 429) {
      expect(response.headers.get('Retry-After')).toBe('60');
      throttled = true;
      break;
    }
    expect(response.status).toBe(400);
  }
  expect(throttled).toBe(true);
});
