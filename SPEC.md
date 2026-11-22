# Switchboard — v0.1 engineering specification

Status: proposed implementation baseline, 22 November 2026.  
License: MIT.  
Audience: human maintainers and implementation agents.

## 1. Purpose

Switchboard is lightweight, durable, provider-neutral communication infrastructure for intelligent agents and ordinary programs. Its first customer is a small multi-agent software workshop. It must remain useful to unrelated applications without requiring that workshop's methodology, model providers, tools or hosting.

Optimize for a domestic budget: dependable, lean, fast, machine-operable, inspectable by humans. Start with ten active endpoints; demonstrate fifty under load. Do not buy capacity in advance or involve an LLM in the server, routing, delivery, polling or housekeeping. The core should be deterministic, with narrowly scoped adapters at the edges.

The defining outcome is that two independently running applications can exchange addressed messages, survive interruption, resume without archaeology, and establish exactly what was persisted and acknowledged. The human-facing Work Board is a view of coordination state, not another mutable source of truth.

## 2. Scope and boundaries

**V0.1 required:** authenticated endpoints, direct and group/channel messaging, durable inbox/outbox, bounded incremental sync, per-recipient receipt, reply correlation, simple presence/status, versioned typed envelopes, discovery, private project/channel visibility, metrics, minimal operator view, export/restore and verified remote MCP interoperability. A local command-line/client adapter demonstrates autonomous sync without model calls.

**Smallest first vertical slice:** two authenticated clients send, sync, acknowledge, retry and recover after restart against a real persisted database; test through MCP and a programmatic interface. Build remaining features from this executable baseline. Do not introduce multiple concurrent writers before clean interfaces exist.

**Not now:** agent launcher/scheduler, model inference, task execution engine, workflow DSL, general-purpose distributed lock, federated broker, arbitrary webhook execution, attachment hosting, vector search, high availability cluster, custom cryptography, or speculative integrations. Existing orchestration, local intercom, source control and knowledge stores stay independent. Future adapters may accelerate notifications but never become the truth of delivery.

## 3. Preferred implementation

- Strict TypeScript; Hono for lightweight HTTP routes and optional server-rendered dashboard; official TypeScript MCP SDK with a supported stateless Streamable HTTP transport; Zod or compatible shared runtime schemas; explicit prepared SQL; Vitest, runtime integration tests and independent adversarial tests.
- Cloudflare Workers + D1 as the initial hosted candidate. Use the established Cloudflare MCP handler/OAuth libraries where their compatibility and security are proven. Avoid a paid identity service unless explicitly approved.
- Provide a real Node.js + SQLite local/self-hosted profile. Keep core types and use cases independent of Cloudflare bindings, Hono, MCP, and driver-specific SQL outside narrow adapters. Reuse portable SQL where feasible; test equivalent behavior against both stores. Verify supported LTS/runtime and SDK versions; pin dependencies with a lockfile.
- Authenticated HTTP/JSON interface and MCP tools call the same domain operations and permission checks, not competing implementations. Expose a small documented versioned API and discovery/health information; do not add a parallel RPC protocol without evidence.
- Keep dependencies and code surface minimal. Use proven libraries instead of hand-writing auth, MCP transport, crypto or retry machinery. Select compatible versions through actual integration tests. Framework choices are preferred, not immutable; preserve the outcomes/invariants if evidence supports a better implementation.

## 4. Domain contract

Use stable opaque endpoint, project, channel, message and conversation identifiers. Bind endpoint identity to authenticated credentials; never trust a caller-supplied sender identity. Distinguish a logical endpoint from a process/session and from live execution. Server timestamps and monotonic sequence values provide deterministic ordering, not client wall-clock order.

A versioned immutable message envelope contains message ID (client-generated idempotency key scoped to authenticated sender), audience (explicit endpoint or channel), project/namespace, kind (namespaced and versioned), subject/summary, bounded payload, priority, thread/reply-to and optional evidence references. Server adds accepted timestamp and recipient delivery sequence. Prefer standard JSON values; unknown message kinds may be stored and retrieved subject to size/authorization, never interpreted as executable instructions. Reserve transport fields; extensions are data not executable code.

Validate references, audience, membership, size and permissions before accepting. A broadcast resolves its intended recipient set atomically at acceptance; later membership edits must not silently grant access to historical private messages. A recipient only sees messages, summaries, counts and status within authorized scope. A reply must reference visible existing content. Per-recipient receipt is durable; one recipient's receipt cannot acknowledge another's. Transport ordering is by explicit sequence; do not claim global causal ordering. Priority may affect dispatch, never cause ordinary messages to starve or disappear.

Lifecycle:
- LOCAL_QUEUED: persisted by client (when a durable adapter is supported).
- STORED: server committed message and intended recipient records; return stable receipt.
- RECEIVED: client has durably recorded the delivery; may be separately reported.
- ACKNOWLEDGED: explicit recipient receipt; not agreement, execution, approval or verified completion.

Deliver at least once until recipient acknowledgement; suppress duplicate logical messages with durable uniqueness constraints and idempotent writes. Retry same sender+message ID with identical canonical content returns same stored ID/receipt; same ID with differing content is a structured conflict. Do not claim exactly-once network delivery or exactly-once external side effects. An ACK may only be committed for a legitimately visible recipient delivery. Failed writes/invalid entries produce unambiguous per-item outcome; transaction boundaries must be documented, and dependent mutations must be atomic. Do not report STORED before commit. A fetch or server response does not by itself prove durable client receipt.

Status is a replaceable latest snapshot with server revision, freshness time and actor; append-only decisions, messages and evidence are not replaceable snapshots. Distinguish available, busy, explicitly waiting, stale and offline/unknown. A heartbeat indicates the adapter contacted the server, not that the model is currently working. Use optimistic concurrency where competing writes could overwrite authoritative state. V0.1 does not infer task completion or ownership from presence.

## 5. API and MCP tools

Expose idiomatic, typed descriptions and bounded output schemas; a newcomer can discover capabilities without GUI access. Minimum semantics (names are negotiable within reason):

- send_message: accept one message and return durable stored receipt.
- sync: batch outgoing messages, explicit acknowledgements, status delta and incremental inbound changes in one request; returns per-item receipts, next cursor, bounded message/header batch, has_more, server time and optional recommended retry/next interval.
- get_inbox: bounded read-only view of unacknowledged or changed deliveries.
- acknowledge: explicit recipient acknowledgement; repeat-safe.
- get_message / get_thread: authorized paginated detail by stable handles.
- list_endpoints / get_status: scoped, bounded discovery and freshness.
- update_status: scoped latest status update.
- get_board: compact scoped coordination/presence and message view.

Expose simple read-only health and authenticated metrics endpoints. Paginate every potentially unbounded collection; no whole-history sync. Cursor must be opaque/versioned, bounded to identity and scope, and deterministic when pages change. A cursor only advances past data durably captured by the client; unacknowledged deliveries must remain retrievable even if a client loses/reset its cursor. When stale cursor cannot be resumed, provide explicit bounded recovery, not silent omission. No hidden remote per-agent transport session is required for correctness.

Use structured result/errors with stable codes for invalid input, unauthorized/forbidden, missing object, conflict, unavailable, throttled and size/limit; include retry hints where appropriate. Auth failures are never automatically retried as transient. Advertise correct tool read/write annotations; no implied authorization to execute received content.

## 6. Synchronization and economy

One durable client mailbox, one in-flight sync per endpoint; a client can queue sends while offline. On response, persist inbound records and receipt/cursor state together before advancing; preserve outgoing requests until confirmed STORED. Implement with ordinary code; never invoke an LLM to check mail. Hosted/chat clients without an always-running adapter can sync on invocation/resume or supported checkpoints; no claim of background waking.

Initial defaults (configurable and subject to measured tuning):
| Item | Initial value |
|---|---|
| Urgent outgoing message | flush immediately |
| Normal outgoing batch linger | up to 3 seconds, flush sooner at bounds |
| Active inbox cadence | 30 seconds |
| Explicitly awaiting response | 10 seconds, limited to 2 minutes then normal |
| Quiet connected endpoint | 60 seconds |
| Idle connected adapter | 120–300 seconds; disconnected/session-ended endpoints do not poll |
| Reconnect/resume/meaningful checkpoint | immediate sync unless backing off |
| Active heartbeat | at most once per 60 seconds, piggyback |
| Stale presence | after 3 missed expected heartbeat intervals; idle cadence explicitly advertised |
| Batch maximum | 32 messages, 256 KiB aggregate encoded input/output separately |
| Inline message body | 32 KiB maximum encoded body |
| Connection / request timeout | 5s / 15s initially |
| Retry | exponential 2s to 120s, jitter; honor longer Retry-After |

Stagger periodic checks with a stable per-endpoint offset. Only one retry layer; bounded immediate retries then degraded mode, no silent deletion; age/backlog and last failure must be visible. Prevent retry/notification storms with per-endpoint budgets, coalescing, and fair scheduling. Prioritize real messages and receipts over telemetry/snapshots. If a queue reaches a configured cap, reject new items explicitly or apply producer backpressure; never silently drop accepted messages. Retain unsent urgent items across restart. Avoid tight loops, repeated empty polls, periodic full scans, large JSON blobs and model context dumps.

Use indexed recipient+sequence/ack lookup, prepared statements, and transactional batches to minimize database round trips. Bound header/body fetch and avoid repeated content. Refer to artifacts by stable links and integrity hashes; private references are permission-filtered. Use HTTP compression if supported and measured useful. No periodic server work without demonstrated need. No polling of the database just to implement long polling; optional event wake-up only if the selected host really supports it. Notifications are hints, with sync as recovery. Urgent *submission* is immediate; receiving clients must be connected and supported to get immediate delivery.

## 7. Security and operational integrity

Private by default even though source code is public. HTTPS, validated tokens, authenticatable distinct endpoint identities, scopes/project membership, scoped human operator access, credential rotation/revocation. Prefer established OAuth resource server patterns for compatible MCP clients; machine credentials can be scoped to individual endpoints where supported. Verify issuer, signature, audience, expiry and permission at the server. The authenticated principal defines the sender. No secrets or real message contents in source, tests, logs, telemetry, public URLs or CI. Never build an open anonymous send/read endpoint.

Apply bounds before expensive parsing/queries. Rate and concurrency limits per principal, explicit overload and retry response; protect against hostile payload, SQL/XSS/injection, cross-project access, replay, forged sender/receipt, unauthorized status edits and confused-deputy calls. Never execute message text, blindly follow links or turn peer messages into higher-authority instructions. Validate schemas at boundaries, fail closed on auth, render message text safely. Keep administrative mutation limited and auditable. Do not auto-launch agents or paid inference.

Maintain one authoritative active delivery store per installation. Export with stable IDs, receipts, cursor/recovery metadata, integrity manifest and version; verify backup restoration and document recovery procedure. Document retention policy; preserve unacknowledged messages, decisions and receipt identity. Archive only by explicit policy with recoverability. Test restart, stale credentials, rejected writes, ambiguous timeout after commit, interrupted responses and lost client local state. Self-hosted fallback is a planned recovery, not active-active split brain: cutover requires fencing the old writer and verifying migration. Legacy board history is imported only after an approved, non-destructive dry run and rollback plan.

## 8. Cost and observability

Hosted target is Cloudflare Workers Paid at $5 USD/month baseline (tax/exchange/overage may differ), subject to owner approval before spending. Published included allowances at design time: 10M Worker requests, 30M CPU-ms, 25B D1 rows read, 50M rows written and 5 GB stored per month. Verify current price, account-wide shared usage and limits before any deployment. Included usage is not a hard cap; set available provider spending protection and separately bound database/storage/auth/log costs, alert well before overage. Never promise unlimited service. Prefer dev/local testing and budgeted staging. No paid resource creation, public deployment, credentials provisioning or production migration without explicit authority.

For 10 continuously active endpoints, 30-second sync produces 864,000 requests in 30 days before send-triggered sync, discovery, auth and other requests; 50 produces 4.32M. Actual workload should be lower via checkpointing/backoff; verify actual CPU and database row costs, not request count alone. Initial design target: ten endpoint normal workshop including sends and protocol overhead stays below half of each monthly included compute/request/database allowance; fifty is stress qualification, not a promise of perpetual operation within the base subscription. Report measured extrapolations and assumptions; alerts at 50/75/90% per resource. Cap log verbosity and telemetry cardinality; do not generate a database write for every empty read merely to count metrics.

Expose structured metrics independently of any other system: counts by operation/outcome, request/response bytes, latency histogram, message age/backlog, retries/deduplications, accepted and acknowledged counts, presence freshness, database rows/CPU where platform reports them, storage and estimated cost. No message bodies/credentials. Use native provider metrics where adequate. Minimal authenticated Work Board view: connection freshness, inbox counts, recent delivery/failed queue state and service health. Human interface is secondary to complete machine-operable API.

## 9. Acceptance and verification

Requirements are observable, not claims. Unit and integration tests must run without paid infrastructure. Record actual commands, configurations, revisions and outputs. Use deterministic clocks/fault injection, multiple clients and real database transactions. Independent adversarial review before production; do not claim prototype tests prove live interoperability.

- Two authenticated clients + actual MCP client and HTTP client exchange messages, correlate replies, acknowledge independently; unauthorized reads/writes rejected. Verify real client schemas, auth and intended protocol versions, and record incompatibilities rather than fake support.
- Concurrent sends, group fan-out, stable pagination including new arrivals and priority, lost network responses, repeated/reordered requests, crash/restart, replay after lost ACK, same ID/different payload, server/client outage and restore: no lost accepted logical messages or duplicate logical records in tested scenarios; re-delivery is allowed and deduplicated. Test ambiguous write outcomes and rejected batch entries.
- Both D1-compatible Worker and local SQLite paths pass shared contract tests; portability is demonstrated, not merely claimed. Export/restore a populated fixture and compare message/receipt IDs and content.
- Ten normal endpoints and 50 simulated endpoints under representative mixed load; test burst backlog, slow clients and failures. Healthy normal sync p95 <= 2s under stated test conditions; active recipient normal message receipt target p95 <= 35s from sender submission, excluding offline/unsupported host behavior. Measure urgent submission separately; no promise to wake inactive AI sessions. Measure request volume, CPU, storage, DB rows and bytes; clear methodology and resource estimates. Tune if target missed, or document and obtain acceptance for tradeoffs.
- Security tests: sender forgery, project isolation, revocation, expired/wrong-audience token, oversize input, injection/XSS, unauthorized acknowledgement/status, replay, rate limiting and safe logs.
- Documentation: run local in a few commands; how to connect MCP and HTTP client; schemas/error codes/limits; backup and restore; deployment and cost controls; explicit known limitations. Make example endpoints/credentials fictional.
- Before replacing an existing messaging transport, independently demonstrate real cross-application round trip (including restart and exact reply ID), qualify ChatGPT/Pi/Antigravity or equivalent actual available hosts, and preserve previously stored history. If a host cannot connect/wake automatically, mark it explicitly and support manual/checkpoint sync. Keep production unchanged until the migration gate is authorized.

## 10. Engineering references

Use primary documentation and re-verify relevant APIs/versions during implementation. These are design precedents, not dependencies unless selected:
- MCP standard: https://modelcontextprotocol.io/
- Official TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Cloudflare remote MCP: https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
- Hono portable web standards: https://hono.dev/docs/concepts/web-standard
- Zod: https://zod.dev/
- D1 batching: https://developers.cloudflare.com/d1/worker-api/
- Cloudflare pricing: https://developers.cloudflare.com/workers/platform/pricing/ and https://developers.cloudflare.com/d1/platform/pricing/
- Matrix incremental sync and transaction IDs: https://spec.matrix.org/latest/client-server-api/
- Kafka bounded producer batching: https://kafka.apache.org/44/configuration/producer-configs/
- Amazon SQS batch operations: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-batch-api-actions.html
- AWS idempotency and jitter: https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/ and https://aws.amazon.com/architecture/exponential-backoff-and-jitter/
- NATS JetStream durability and acknowledgements: https://docs.nats.io/concepts/jetstream

## 11. Authority and evolution

Implementer may choose sequence, libraries, schema details and reversible improvements based on evidence. Preserve the intended behavior, security, cost envelope, portability and acceptance floor. If a better mechanism satisfies those constraints, prefer it and explain why. Do not invent unrelated requirements or defer the observable end-to-end outcome behind speculative scaffolding. Record decisions and evidence, keep the repository understandable for the next agent, commit coherent verified slices and push a reviewable development branch. Escalate only real authority, safety, incompatible requirements, blocked external integration, spending or irreversible migration. An independent review is required before production acceptance.
