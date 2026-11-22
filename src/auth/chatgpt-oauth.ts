import { timingSafeEqual } from 'node:crypto';
import type { OAuthProvider, OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { sha256 } from './auth-service.js';
import type { AuthPrincipal } from '../core/types.js';

const endpointId = 'lucy-chat';
const scope = 'switchboard';
const routes = {
  mcp: '/mcp/chatgpt',
  authorize: '/oauth/chatgpt/authorize',
  token: '/oauth/chatgpt/token',
  register: '/oauth/chatgpt/register',
  issuerMetadata: '/.well-known/oauth-authorization-server',
  resourceMetadata: '/.well-known/oauth-protected-resource/mcp/chatgpt',
  rootMetadata: '/.well-known/oauth-protected-resource',
};
const oauthPaths = new Set<string>(Object.values(routes));
const limitedPaths = new Set<string>([routes.authorize, routes.register, routes.token, routes.mcp]);

export interface ChatGptOAuthEnv {
  CHATGPT_OAUTH_ORIGIN?: string;
  CHATGPT_OAUTH_PROJECT?: string;
  CHATGPT_OAUTH_REDIRECTS?: string;
  CHATGPT_OAUTH_OWNER_HASH?: string;
  OAUTH_KV?: unknown;
  CHATGPT_OAUTH_LIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}

type OAuthContext = Parameters<OAuthProvider<ChatGptOAuthEnv>['fetch']>[2];

function validScopes(scopes: string[]) {
  return scopes.every((requested) => requested === scope);
}

export async function routeChatGptOAuth(
  request: Request,
  env: ChatGptOAuthEnv,
  ctx: OAuthContext | undefined,
  serve: (request: Request, principal: AuthPrincipal) => Promise<Response>,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!oauthPaths.has(url.pathname)) return;
  const origin = env.CHATGPT_OAUTH_ORIGIN;
  const projectId = env.CHATGPT_OAUTH_PROJECT;
  const ownerHash = env.CHATGPT_OAUTH_OWNER_HASH;
  const redirects = (env.CHATGPT_OAUTH_REDIRECTS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!ctx || !env.OAUTH_KV || !env.CHATGPT_OAUTH_LIMIT || !origin || url.origin !== origin || url.protocol !== 'https:' ||
      !projectId || !ownerHash || !/^[a-f0-9]{64}$/.test(ownerHash) || !redirects.length) {
    return new Response(null, { status: 404 });
  }
  if (url.pathname === routes.mcp && url.search) return new Response(null, { status: 400 });

  if (limitedPaths.has(url.pathname)) {
    const { success } = await env.CHATGPT_OAUTH_LIMIT.limit({ key: url.pathname });
    if (!success) return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
  }

  const { AuthorizationError, OAuthError, OAuthProvider, getOAuthApi } =
    await import('@cloudflare/workers-oauth-provider');
  const resource = origin + routes.mcp;
  const allowsRedirect = (uri: string) => redirects.includes(uri);
  type Approval = { ownerHash: string; projectId: string; redirectUri: string };
  const hasApproval = (props: Approval | undefined) =>
    props?.ownerHash === ownerHash && props.projectId === projectId && allowsRedirect(props.redirectUri ?? '');

  const options: OAuthProviderOptions<ChatGptOAuthEnv> = {
    apiRoute: routes.mcp,
    resourceMetadata: { resource },
    requiredScopes: [scope],
    scopesSupported: [scope],
    clientIdMetadataDocumentEnabled: false,
    onError: () => undefined,
    authorizeEndpoint: routes.authorize,
    tokenEndpoint: routes.token,
    clientRegistrationEndpoint: routes.register,
    accessTokenTTL: 600,
    refreshTokenTTL: 604800,
    clientRegistrationCallback({ clientMetadata }) {
      const uris = clientMetadata.redirect_uris;
      if (!Array.isArray(uris) || !uris.length || !uris.every(allowsRedirect)) {
        return { code: 'invalid_redirect_uri', description: 'Unapproved redirect URI' };
      }
      return undefined;
    },
    tokenExchangeCallback(options) {
      if (!hasApproval(options.props) || options.userId !== endpointId ||
          options.resource !== resource || !validScopes(options.requestedScope)) {
        throw new OAuthError('invalid_grant', { description: 'Grant is no longer authorized' });
      }
    },
    apiHandler: {
      async fetch(apiRequest: Request, _env: ChatGptOAuthEnv, context: OAuthContext & { props?: Approval; auth?: { scope: string[]; userId: string } }) {
        if (!hasApproval(context.props) || context.auth?.userId !== endpointId || !context.auth.scope.includes(scope)) {
          return new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': 'Bearer error="invalid_token", resource_metadata="' +
              origin + routes.resourceMetadata + '"' },
          });
        }
        return serve(apiRequest, { endpointId, projectId, role: 'agent', scopes: ['read', 'write'] });
      },
    },
    defaultHandler: {
      async fetch(authRequest: Request, authEnv: ChatGptOAuthEnv) {
        if (url.pathname !== routes.authorize) return new Response(null, { status: 404 });
        const oauth = getOAuthApi(options, authEnv);
        const headers = {
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
        };
        try {
          if (authRequest.method === 'GET') {
            const parsed = await oauth.parseAuthRequest(authRequest);
            if (!allowsRedirect(parsed.redirectUri) || parsed.resource !== resource ||
                parsed.codeChallengeMethod !== 'S256' || !validScopes(parsed.scope)) {
              return new Response('Invalid authorization request', { status: 400, headers });
            }
            const consent = await oauth.beginConsent(parsed);
            for (const [name, value] of Object.entries(headers)) consent.headers.set(name, value);
            // Chromium sends Origin: null for a POST from a no-referrer document.
            consent.headers.set('Referrer-Policy', 'strict-origin');
            consent.headers.set('Content-Type', 'text/html; charset=utf-8');
            const redirectHost = new URL(parsed.redirectUri).hostname;
            return new Response(
              '<!doctype html><html lang="en"><meta charset="utf-8"><title>Switchboard approval</title>' +
              '<h1>Approve Switchboard access</h1><p>Grant ' + redirectHost +
              ' read and write access as lucy-chat.</p><form method="post" action="' + routes.authorize + '">' +
              '<input type="hidden" name="handle" value="' + encodeURIComponent(consent.handle) + '">' +
              '<label>Owner passphrase <input name="owner" type="password" required autocomplete="off"></label>' +
              '<button type="submit">Verify and approve</button></form></html>',
              { headers: consent.headers },
            );
          }
          if (authRequest.method !== 'POST') return new Response(null, { status: 405, headers });
          if (authRequest.headers.get('Origin') !== origin ||
              !authRequest.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) {
            return new Response(null, { status: 403, headers });
          }
          const reader = authRequest.body?.getReader();
          const decoder = new TextDecoder();
          let formBody = '';
          let bytes = 0;
          if (reader) {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 4096) {
                await reader.cancel();
                return new Response(null, { status: 413, headers });
              }
              formBody += decoder.decode(value, { stream: true });
            }
            formBody += decoder.decode();
          }
          const form = new URLSearchParams(formBody);
          const supplied = await sha256(form.get('owner') ?? '');
          if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(ownerHash))) {
            return new Response('Owner verification failed', { status: 403, headers });
          }
          const approved = await oauth.approveConsent(authRequest, form.get('handle') ?? '', { scope: [scope] });
          const { redirectTo } = await oauth.completeAuthorization({
            request: approved.request,
            userId: endpointId,
            revokeExistingGrants: false,
            metadata: {},
            scope: [scope],
            props: { ownerHash, projectId, redirectUri: approved.request.redirectUri },
          });
          for (const [name, value] of Object.entries(headers)) approved.headers.set(name, value);
          approved.headers.set('Location', redirectTo);
          return new Response(null, { status: 303, headers: approved.headers });
        } catch (err) {
          if (!(err instanceof AuthorizationError)) throw err;
          return new Response('Invalid or expired authorization request', { status: 400, headers });
        }
      },
    },
  };

  return new OAuthProvider(options).fetch(request, { ...env }, ctx);
}
