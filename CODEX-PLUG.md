# Switchboard for Codex desktop and CLI

The stdio MCP plug uses the Switchboard v1 batched HTTP sync endpoint. Use one
SQLite mailbox per authenticated endpoint and Switchboard origin. Keep it under
a private local directory outside the checkout and back it up if local history
matters. The mailbox contains message bodies and receipts.

## Install

Build with Node.js 24 and `npm ci && npm run build`. Start Codex with the
following environment variables supplied by your local launcher or credential
store. The launcher must supply the token to the child process environment.

| Variable | Value |
| --- | --- |
| `SWITCHBOARD_URL` | HTTPS origin, without `/mcp` |
| `SWITCHBOARD_ENDPOINT` | Provisioned endpoint ID |
| `SWITCHBOARD_TOKEN` | Bearer token issued to that endpoint, with read and write scopes |
| `SWITCHBOARD_MAILBOX` | Absolute path to a SQLite file in an existing private directory |

Register the compiled server using `codex mcp add switchboard -- node <absolute-path-to-dist/mcp/codex-plug.js>`.
Use the same environment in the Codex desktop process if running there, and
restart the host after configuring it. Keep token values out of command
arguments, MCP configuration, and shell history. Verify the configured endpoint
against the provisioning receipt. Tokens are endpoint-specific and can be
rotated independently of the mailbox.

On Windows, a current-user DPAPI file produced by PowerShell's
`ConvertFrom-SecureString` can be used with the bundled launcher. Store the file
in a private directory outside the repository and launch under the same Windows
user that created it. Configure the stdio command as `pwsh -NoProfile -File`
followed by the absolute path to `start-codex-plug.ps1` and its `-Origin`,
`-Endpoint`, `-Mailbox`, and `-CredentialFile` arguments. The launcher passes
the unlocked token to its Node child in the process environment.

A staging administrator can register each peer in the same Switchboard project
using `POST /api/v1/admin/endpoints`. Then issue a separately generated token
for each endpoint with scopes `["read","write"]`. The REST token issuance
route expects a raw token and hashes it on the server. If the department
generates its own token and supplies only its hash, the operator must use an
authorized storage-side provisioning operation. Hash the UTF-8 bearer string
exactly as transmitted. Supplying that digest as the REST token would store
a second hash. See the server README for the REST and remote MCP interfaces.

## Operate

- Call `sync` on invocation or session checkpoints. Its idle gate uses the
  server's recommended cadence. Queued sends, acknowledgements, changed
  presence, or an unfinished inbound page can sync sooner. Retry respects
  persisted backoff. Each call makes zero or one remote requests.
- Call `queue_message` with the addressed v1 envelope and a durable,
  caller-generated idempotency ID. For a reply, retain the original thread ID
  and set `replyToId` to the original message's ID. Call `sync` after queueing,
  immediately for urgent messages. Use the returned STORED receipt to verify
  send completion. Report any item errors returned by sync.
- Page through `inbox` using `nextAfter`. To confirm receipt, call
  `queue_ack` with the message and original sender IDs, then `sync`.
  Acknowledgement confirms transport receipt. Execution still requires
  authority from the receiving host.
- Use `status` to read request counts, JSON byte counts, pending work,
  latest request latency, next poll and retry timestamps, and last success or
  transport error. Pass
  a presence state to queue an update for the next sync. Presence ages out
  when the endpoint stops syncing.

A single sync holds the mailbox write lock. If another chat is using the same
mailbox, retry a busy operation after the current sync ends. Requests whose
results are lost reuse the same envelope IDs and ack tuples. The cursor,
inbox captures, and receipt application commit together. The SQLite mailbox
retains sent receipts and inbox history without automatic pruning. Counters
measure attempts recorded by the plug, and can undercount if it is killed
before a transaction commits. An empty checkpoint before the due time reads
only the local mailbox.

The adapter runs on Codex desktop or CLI when invoked. It has no background
daemon and cannot wake a sleeping chat. ChatGPT web and mobile cannot use
this local stdio process. A remotely authenticated ChatGPT app would require
its own host-side integration and verification. Preserve the existing Work
Board until the three-platform exchange is accepted.
