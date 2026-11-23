# Switchboard

## Optional Oracle telemetry (provisional)

Disabled by default; there is no Oracle dependency. For a local Node server only,
set `SWITCHBOARD_TELEMETRY=1` to enable a private JSONL file per server run in
`.switchboard-telemetry/` (override with `SWITCHBOARD_TELEMETRY_DIR`). Leave the
setting unset until qualification. The Worker does not use the local sink.

`oracle.toml` declares the permitted signals. Each record contains `v`, `seq`
(per-run monotonic observation sequence; gaps indicate dropped observations),
`kind`, `name`, `value`, `unit`, and UTC `observed_at`. Counters are increments,
gauges are snapshots, events have value 1, and durations are milliseconds.
Only request timing, aggregate counts and lifecycle events are observed; no
request paths, identifiers, headers, credentials, bodies or error text.

The asynchronous sink drops observations on overload, disk failure or the 1 MiB
per-run limit, with at most 256 queued records plus one in-flight batch. It never
waits for disk during request handling. On orderly server close it attempts to
flush; abrupt termination may lose the final batch. Old files remain available
for operator-controlled archival; this is not a durable messaging log. The
portable `ObservationTransport` boundary is replaceable when the official Oracle
plug is ready. The wire contract is provisional pending Oracle v0.1.

Standalone adapter verification (Node 24+):

```sh
node --test tests/telemetry/adapter.node-test.mjs
```

### Operational controls

- `GET /health` is cheap liveness (including `mode: running|paused`), not a claim
  that the database is operational. Authenticated `GET /api/v1/readiness` checks
  the delivery schema using bounded, read-only queries and returns 503 if unavailable.
- Discovery advertises REST protocol version 1. Clients may send
  `X-Switchboard-Protocol: 1`; older clients without the header still use v1.
  Unsupported versions receive a structured error. MCP negotiates independently.
- Emergency brake: set `SWITCHBOARD_PAUSED=1` and restart Node, or set the Worker
  environment variable through an approved deployment. Requests other than liveness
  and discovery receive 503 with `Retry-After: 120` before authentication/DB work.
  Unset the flag and restart/redeploy to resume. The brake does not delete messages
  and does not stop provider-level billing for incoming requests. It is not an
  account-wide automatic cost cap.

Lean, dependable communication infrastructure for AI agents and ordinary programs.

Switchboard provides durable addressed messaging, bounded incremental synchronization, per-recipient acknowledgements, scoped presence, and coordination through the Model Context Protocol (MCP) and a lightweight REST API. It is provider-neutral, self-hostable, and engineered for small teams and modest budgets.

**Status:** v0.1 Foundation implemented and qualified.

---

## Architecture & Guarantees

- **No LLM in the core:** Deterministic message delivery, routing, and sync. Zero inference cost or token overhead inside the transport.
- **Durable delivery & receipts:** Every accepted message is durably stored before returning a stable receipt. Messages are delivered at least once until explicitly acknowledged by the recipient.
- **Idempotency & conflict detection:** Message IDs are scoped to the authenticated sender. Replaying the identical message returns the existing stored receipt (`isDuplicate: true`); reusing the same ID with different content returns a structured `CONFLICT` (409).
- **Atomic channel fanout:** Group channels resolve active member recipients atomically at acceptance time. Future members do not receive historical private messages.
- **Dual storage profiles:**
  - **Self-Hosted:** Node.js (24+) and SQLite (`node:sqlite`) with WAL mode.
  - **Hosted Candidate:** Cloudflare Workers and Cloudflare D1.
- **Adaptive timings:** Piggybacked heartbeats, automatic cadence adaptation (urgent immediate flush, active 30s, awaiting response 10s, quiet 60s, idle 180s, stale presence detection at 180s, exponential backoff with jitter).
- **Security & isolation:** Strict project boundaries, token authentication (SHA-256 stored hashes), immutable principal-derived sender identity, bounded payload sizes (max 32 KiB body, 32 messages / 256 KiB batch), rate limiting, and XSS-safe dashboard rendering.

---

## Quick Start (Self-Hosted)

### 1. Requirements

- Node.js 24 or later with `node:sqlite`
- npm or pnpm

### 2. Install & Build

```bash
git clone https://github.com/matthewjameswatkins1978-cyber/switchboard.git
cd switchboard
npm install
npm run build
```

### 3. Run Tests

```bash
npm run test
```

### 4. Start the Server

```bash
# Start with in-memory or SQLite database
PORT=3000 DATABASE_PATH=switchboard.sqlite INITIAL_ADMIN_TOKEN=admin-secret-token npm start
```

Once running:
- **Health Check:** `http://localhost:3000/health`
- **Capabilities & Limits:** `http://localhost:3000/api/v1/discovery`
- **Work Board UI:** `http://localhost:3000/board` (Pass `Authorization: Bearer <token>`)
- **Metrics:** `http://localhost:3000/metrics`

---

## Connecting MCP Clients

Switchboard implements the official Model Context Protocol (MCP) standard using `@modelcontextprotocol/sdk`.

### Server Tools Exposed

| Tool | Parameters | Description |
|---|---|---|
| `send_message` | `id`, `recipient_type`, `recipient_id`, `kind`, `subject`, `payload`, `priority`, `thread_id`, `reply_to_id`, `evidence_refs` | Durably store message and return recipient receipt |
| `sync` | `since_cursor`, `limit`, `include_acknowledged`, `outgoing_messages`, `acknowledgements`, `status_update` | Atomic batch synchronization |
| `get_inbox` | `limit`, `offset` | Bounded read-only view of unacknowledged deliveries |
| `acknowledge` | `message_id`, `sender_id`, `note` | Repeat-safe explicit recipient acknowledgement |
| `get_message` | `message_id`, `sender_id` | Fetch single authorized message envelope |
| `get_thread` | `thread_id`, `limit` | Chronologically fetch correlated thread messages |
| `list_endpoints` | *(none)* | Discover registered endpoints and freshness |
| `get_status` | `endpoint_id` | Retrieve latest presence snapshot for an endpoint |
| `update_status` | `state`, `description`, `expected_revision` | Update presence with optimistic concurrency check |
| `get_board` | *(none)* | Compact coordination board overview |

### SSE Transport URL

Connect your agent harness (Pi, Claude Code, Cursor, Antigravity) to:
```
http://localhost:3000/mcp/sse
Authorization: Bearer <your-endpoint-token>
```

---

## REST API Reference

All requests must include `Authorization: Bearer <token>`.

### Core Endpoints

- `POST /api/v1/messages`: Accept one message, return stored receipt.
- `POST /api/v1/sync`: Batch outbox, acks, status update, and inbound sync.
- `GET /api/v1/inbox?limit=32&offset=0`: Unacknowledged inbound messages.
- `POST /api/v1/acknowledgements`: Explicitly acknowledge one or more deliveries.
- `GET /api/v1/messages/:id`: Get authorized message.
- `GET /api/v1/threads/:id`: Get correlated thread messages.
- `GET /api/v1/endpoints`: List endpoints in project.
- `GET /api/v1/endpoints/:id/status`: Get status of an endpoint.
- `PUT /api/v1/status`: Update status snapshot with optimistic concurrency.
- `GET /api/v1/board`: Compact coordination summary.
- `POST /api/v1/export`: Export project data with SHA-256 manifest.
- `POST /api/v1/import`: Import and restore project data verified against manifest checksum.

---

## Cloudflare Workers & D1 Deployment

Switchboard is fully compatible with Cloudflare Workers and D1:

1. Create a D1 database:
   ```bash
   npx wrangler d1 create switchboard-db
   ```
2. Update database ID in `wrangler.toml`.
3. Deploy:
   ```bash
   npx wrangler deploy
   ```

---

## Performance & Economy

Keep ordinary polling cheap: passive heartbeats coalesce within the configured 60-second interval, with an earlier refresh if the next advertised cadence would threaten the freshness margin. Explicit presence updates remain immediate. Waiting presence uses 10-second polling for at most two minutes, then returns to 30 seconds before budget multipliers. Usage increments and rollover use one atomic database statement rather than a read followed by a write. These changes preserve durable messages and acknowledgements; measured provider totals still depend on workload and indexes.

Under rigorous load qualification (`tests/load/capacity.test.ts`):
- **10 Active Endpoints:** P95 latency **~3.5 ms** (well below the 2000 ms SLA).
- **50 Concurrent Endpoints:** P95 latency **~17.5 ms** with zero message loss and zero duplicate deliveries.
- **Operating Cost Target:** Designed to run comfortably within Cloudflare Workers Paid ($5/mo baseline) allowances (10M requests, 25B row reads, 50M row writes, 5 GB storage).

---

## License

[MIT](LICENSE).
