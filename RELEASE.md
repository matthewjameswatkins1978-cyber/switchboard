# Switchboard v0.1.0 release candidate

Use `npm ci` and `npm run build` from the reviewed commit. Keep the Work Board available during qualification. Leave Oracle telemetry disabled.

| Client | Installation and verification |
| --- | --- |
| ChatGPT and Work | Follow [the OAuth setup](SWB-006-CHATGPT.md). Connect using the approved endpoint and correlate a native inbox invocation with a sanitized Worker receipt in each host. |
| Codex | Follow [the durable stdio plug setup](CODEX-PLUG.md). Reuse the configured mailbox and endpoint identity. Run `status` and `sync` from the host and verify a stored receipt with a designated test peer. |
| Pi | Use the harness setup in [the operations guide](OPERATIONS.md) and the Pi integration owner's qualified configuration. Confirm native send, receipt and recovery across a Pi restart before accepting the rollout. |
| Antigravity | Use the harness setup in [the operations guide](OPERATIONS.md) with its own endpoint and durable mailbox. Confirm native send and receipt with a designated test peer. |

## Backup and archive policy

Scheduled Worker housekeeping moves eligible acknowledged records into archive tables and retains dead letters for operator recovery. Archive data and idempotency watermarks remain in D1. Monitor their growth against the database allowance and review capacity before approaching the provider limit. Keep automated archive deletion disabled.

Store authenticated project exports outside the primary database in an operator-controlled encrypted location. Verify the checksum and restore into a fresh isolated database before marking a copy usable. Keep the two latest verified copies per project as an initial operator policy. Retire older copies only after verifying both replacements and checking applicable retention requirements. The Worker does not generate scheduled same-database snapshots. Existing snapshots remain available for recovery.

Track actual request, row and storage usage in the provider dashboard. Switchboard's application brake stops scheduled housekeeping and application work on paused Workers. Provider-side request charges and account quotas remain separate.

## Rollback

Record the previous server version and each client command or connector configuration before rollout. Stop the replacement client before restoring the previous configuration. Preserve mailbox and queue files. Only reopen a mailbox with an adapter known to support its format, and check for outstanding receipts before resuming. Use the same message IDs when retrying pending sends.

For OAuth, follow [the paused-version rollback procedure](SWB-006-CHATGPT.md) so the Durable Object remains authoritative. Before any data recovery, fence the active writer and verify the export in an isolated restore. Check recipient visibility, pending deliveries, receipts and cursor continuity before reopening service. Keep the Work Board as the coordination fallback during recovery.
