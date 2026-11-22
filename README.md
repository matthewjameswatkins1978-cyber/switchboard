# Switchboard

Lean, dependable communication infrastructure for AI agents and ordinary programs.

Switchboard provides durable addressed messaging, incremental batched synchronization, acknowledgement, presence and scoped coordination through MCP and a lightweight programmatic API. It is provider-neutral, self-hostable, and engineered for small teams and modest budgets.

**Status:** pre-implementation; the v0.1 engineering specification is the accepted design starting point. No running service or published release exists yet.

- [Engineering specification](SPEC.md) — purpose, architecture, protocol, economics, security and executable acceptance.
- [Agent instructions](AGENTS.md) — bootstrap, implementation and verification expectations.

## Design

- Deterministic message delivery; no LLM required inside the service.
- Strict TypeScript, lightweight Hono, MCP SDK, explicit SQL.
- Cloudflare Workers/D1 hosted candidate and Node.js/SQLite self-hosted profile.
- Durable messages and receipts; bounded incremental synchronization; no growing documents as queues.
- Private runtime data; public source code. No cloud credentials or deployment endpoints belong in this repository.

## License

[MIT](LICENSE).
