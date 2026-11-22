# SWB-006 Native ChatGPT OAuth

## Staging registration

Target MCP URL: https://switchboard-staging.matthewjameswatkins1978.workers.dev/mcp/chatgpt

After the OAuth-enabled staging version is live, open ChatGPT Plugins, select
**+ → Add custom MCP server**, and enter these settings.

| Field | Value |
| --- | --- |
| Name | Switchboard Staging |
| Server URL | The target MCP URL above |
| Authentication | OAuth |
| OAuth client | Dynamic client registration |
| Client ID and secret | Leave blank for dynamic registration |
| Scope | `switchboard` if the form asks |

Select **Create as a plugin**, keep it personal, then install and connect it.
Verify that the OAuth approval page is on the exact staging hostname above.
Enter the owner passphrase there and choose **Verify and approve**. Obtain the
passphrase through the owner's local password manager.

The authorization server returns `iss` on successful redirects and advertises RFC
9207 support. The expected ChatGPT callback is
`https://chatgpt.com/connector_platform_oauth_redirect`. Confirm the callback on
the connection's management page. If the UI shows a different callback, use the
exact HTTPS URL shown. The stable callback is shared by ChatGPT connections.
Only approve a flow you started from your own personal plugin. The Worker uses
an exact allowlist. See
[OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth)
and [plugin connection](https://developers.openai.com/plugins/deploy/connect-chatgpt).

## Deploy and roll back

Use the existing staging Worker and its current D1 binding. The `lucy-chat`
agent must already exist in the designated staging project. The OAuth route is
disabled unless all four configuration values and the dedicated KV binding are
present, along with the rate limiting binding. Set these only on staging.

- `CHATGPT_OAUTH_ORIGIN` is the staging HTTPS origin without a trailing slash.
- `CHATGPT_OAUTH_PROJECT` is the existing staging project that owns `lucy-chat`.
- `CHATGPT_OAUTH_REDIRECTS` is a comma-separated list of exact approved callbacks.
- `CHATGPT_OAUTH_OWNER_HASH` is a Worker secret containing the lowercase SHA-256
  digest of a locally generated, uniformly random owner passphrase of at least
  32 bytes, encoded before hashing. Hash the exact text typed into the approval
  form. Keep the passphrase in the owner's password manager.
- `OAUTH_KV` is a dedicated staging KV namespace for grants, clients and consent.
  Confirm included KV capacity before provisioning or enabling it.
- `CHATGPT_OAUTH_LIMIT` is a dedicated Wrangler `ratelimits` binding. Use an
  unused account-local numeric namespace ID and a limit of 60 per 60 seconds.
  The Worker applies the limit per route and Cloudflare location.

Record the current serving staging version and settings. Prepare a private
Wrangler staging configuration with the existing name, D1 ID and compatibility
settings. Preserve current scheduling, routing and other bindings. Upload without
shifting traffic using `wrangler versions upload --config <private-config>
--keep-vars --secrets-file <private-json>`. The temporary JSON contains only
`CHATGPT_OAUTH_OWNER_HASH`. Store it outside the repository and remove it after
upload. Promote the uploaded version using `wrangler versions deploy
<new-version-id>@100% --name switchboard-staging`. Keep request/invocation
logging off to avoid retaining
OAuth URLs. A live log tail or Workers Logs configured for console events only
can observe the application receipts during a controlled acceptance run.

If staging fails qualification, use `wrangler rollback <prior-version-id>
--name switchboard-staging`. Verify legacy authenticated MCP and that the OAuth
route is gone. Reuse the existing stage D1 database throughout. Choose a new
owner hash before later reenabling OAuth if all previous grants should be
invalidated. Removing an allowed callback also disables grants for that callback.
RFC 7009 revocation is available at the advertised token URL. Allow for Workers
KV propagation on edge revocation.

The OAuth token grants the normal agent's messaging access in that project.
New access tokens expire after one hour and refresh grants after seven days.
OAuth grants cannot mint static bearer credentials. Existing bearer clients
continue to use `/mcp`.

## Acceptance

In a fresh ordinary Chat conversation, explicitly select the personal plugin
and ask it to call `get_status` for `lucy-chat`, `list_endpoints`, and
`get_inbox` with a limit of 1. Ask it to return the three Switchboard receipt
IDs without quoting message content. Match each ID and tool name to an
independent `switchboard.oauth.tool` Worker console event. Repeat in a fresh
Work conversation with a separate set of receipt IDs. Keep message content,
token material and OAuth URLs out of the evidence. A receipt on a read confirms
the Worker handled that call. Acknowledgement is an explicit operation.

For staging messaging qualification, use a dedicated test conversation with
fictional messages and confirm the stored and acknowledged receipts for both
directions. Local runtime coverage is in
`tests/adversarial/chatgpt-oauth.test.ts`. The test runs the bundled Worker with
persisted D1 and KV, and exercises the normal MCP SDK over Streamable HTTP.
Native Chat and Work acceptance are separate from this test.

## SWB-007 refresh persistence

The staging Worker uses a SQLite-backed Durable Object bound as
`CHATGPT_OAUTH_STATE`. Keep `OAUTH_KV` bound as a read-only migration source.
Durable revocation records fence reads of old grants and tokens. Legacy
fallback ends 91 days after the actor is initialized.

Token requests are serialized. An exact refresh retry within two minutes
receives the same successor while its grant and access token are current
and active. The stored response is encrypted using a key derived from the
presented refresh credential. The window does not extend either lifetime.
The provider validates the client, resource, scope and approval on the
initial exchange. Prior credentials outside the retry window are rejected.

Use the private staging config with a `new_sqlite_classes` migration for
`ChatGptOAuthState` and `CHATGPT_OAUTH_DISABLED=1` for the initial
`wrangler deploy`. That version fences the old KV writer while keeping
static bearer routes available. After the KV propagation window, upload
and promote the same commit at 100% with `CHATGPT_OAUTH_DISABLED=0`.
Roll back to the paused version if needed. Returning to a pre-migration
KV writer can revive stale state, including grants revoked after cutover.

Token diagnostics emit provider classifications and fixed policy booleans
to the console. Correlate fresh Chat and Work receipt IDs to Worker events
without capturing message contents or request data.

The adversarial test reproduces stale KV reads and delayed duplicate replies
before cutover. The Durable Object phase verifies 20 authenticated calls,
repeated rotation, concurrent refresh, retry across a process restart,
expiry and revocation of pre-cutover and newly issued credentials.
