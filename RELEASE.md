# Switchboard v0.1.0 release candidate

Use `npm ci` and `npm run build` from the reviewed commit. Use Switchboard for routine coordination and retain the legacy Work Board history for emergency reference. Leave Oracle telemetry disabled.

| Client | Installation and verification |
| --- | --- |
| ChatGPT and Work | Follow [the OAuth setup](SWB-006-CHATGPT.md). Connect using the approved endpoint and correlate a native inbox invocation with a sanitized Worker receipt in each host. |
| Codex | Follow [the durable stdio plug setup](CODEX-PLUG.md). Reuse the configured mailbox and endpoint identity. Run `status` and `sync` from the host and verify a stored receipt with a designated test peer. |
| Pi | Use the harness setup in [the operations guide](OPERATIONS.md) and the Pi integration owner's qualified configuration. Confirm native send, receipt and recovery across a Pi restart before accepting the rollout. |
| Antigravity | Use the harness setup in [the operations guide](OPERATIONS.md) with its own endpoint and durable mailbox. Confirm native send and receipt with a designated test peer. |

## Backup and archive policy

Scheduled Worker housekeeping moves eligible acknowledged records into archive tables and retains dead letters for operator recovery. Archive data and idempotency watermarks remain in D1. Monitor their growth against the database allowance and review capacity before approaching the provider limit. Keep automated archive deletion disabled.

Run the one-shot D1 exporter on an existing trusted host with Node 24 or newer, the reviewed checkout and `npm ci`. Use one pre-created private backup directory per database, outside the checkout, on encrypted storage with restrictive ACLs and a filesystem quota. Use low-privilege Cloudflare credentials scoped to the database's account and the permissions needed for export. Supply them through the scheduler's protected environment or the scheduled user's private Wrangler profile. Keep credentials out of command lines, configuration committed to Git, and logs.

```text
node bin/sb-d1-backup.js --remote /private/staging.toml DB /private/backup-staging
```

Use `--local` with an isolated Wrangler test configuration for a drill. Run twice successfully before relying on the schedule. The exporter hashes the SQL, loads it into a fresh in-memory SQLite store, checks required tables and SQLite integrity, and commits the generation with a checksum file. Keep the newest two verified generations. The default verification limit is 64 MiB per artifact. The optional fifth argument sets that limit in bytes. Budget for three exports plus SQLite verification memory during publication. A dedicated storage quota provides a hard disk limit during the provider download.

After approval, register the command with the host scheduler (Task Scheduler or cron) for one daily run in a maintenance window. Use the reviewed checkout as the working directory and an absolute Node executable. Set the task to run as the dedicated user, skip overlapping runs, and record exit codes. A single export attempt is capped at two minutes. Re-enable the schedule to resume after resolving a failure. Cloudflare's SQL export can block D1 queries while the dump runs. Measure the duration on an isolated fixture before choosing an active service window. Keep the provider's application and backup credentials separate. The SQL backup includes credential hashes and all D1 project history. The OAuth Durable Object and Worker configuration have separate recovery procedures.

Monitor `status.json` and task exit codes. Alert after any failed attempt or if the latest success is older than 36 hours. Alert at 50%, 75%, and 90% of the database allowance and backup quota. If a host interruption leaves `.backup-lock`, clear the empty lock directory only after confirming the exporter is stopped. On recovery, use `node bin/sb-d1-backup.js --restore <artifact.sql> <new-isolated.sqlite>` in a private directory. It verifies the sidecar before loading SQL and refuses an existing target. Use the resulting isolated SQLite file to verify receipts and replay behavior before proposing a hosted recovery. Keep the automatic Worker snapshots off and preserve the existing snapshots.

Track actual request, row and storage usage in the provider dashboard. Switchboard's application brake stops scheduled housekeeping and application work on paused Workers. Provider-side request charges and account quotas remain separate.

## Rollback

Record the previous server version and each client command or connector configuration before rollout. Stop the replacement client before restoring the previous configuration. Preserve mailbox and queue files. Only reopen a mailbox with an adapter known to support its format, and check for outstanding receipts before resuming. Use the same message IDs when retrying pending sends.

For OAuth, follow [the paused-version rollback procedure](SWB-006-CHATGPT.md) so the Durable Object remains authoritative. Before any data recovery, fence the active writer and verify the export in an isolated restore. Check recipient visibility, pending deliveries, receipts and cursor continuity before reopening service. Use the legacy Work Board history for emergency reference if needed.

## Release qualification

| Gate | Evidence and remaining work |
| --- | --- |
| Build and compatibility | Clean Node 24 install and build. 91 tests passed with two opt-in staging tests skipped. Prior Pi restart qualification is credited to its integration owner. Native Work `get_inbox` was matched to the independent Worker event by receipt ID. |
| Housekeeping and emergency brake | The local Worker/D1 suite verifies the 501-delivery archive workload at the 100/500 batch sizes and the application brake. Run the equivalent workload and brake checks on a separately bound hosted fixture. Leave workshop records untouched. |
| External backup and restore | Isolated Wrangler D1 fixture passed three exports, fresh restores, checksum checks, two-generation retention and a recorded failure. Before enabling a daily job, qualify the remote export and time its effect using the isolated hosted database. |
| Hosted economics | Read account-wide Worker request/CPU and D1 row/storage analytics before acceptance. Compare provider allowances with the intended cadence and confirm alerts and any account-side controls. Included usage allowances can be exceeded on paid plans. |

For hosted qualification, use a separate approved Worker configuration and D1 binding, disable its cron initially, and provision fictional fixture data only. Exercise normal and paused request handling against that fixture, run housekeeping with 501 stale deliveries at batch bounds of 100 and 500, and confirm archived rows, dead letters and replay identity. Export that database to the trusted host, restore into fresh isolated SQLite, compare the delivery counts and replay a prior ID. Record provider usage before and after. Use the existing active hosting configuration solely for read-only corroboration.

For release, use the independently accepted PR commit and repeat the smoke checks from a clean install. Record the serving Worker version, pause and rollback versions, and client configurations. Publish the `v0.1.0` tag and begin the rollout only after independent acceptance and owner approval.
