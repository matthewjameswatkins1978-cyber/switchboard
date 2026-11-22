# Agent instructions

Read [SPEC.md](SPEC.md) before choosing architecture or implementing. It is the engineering baseline; the implementation plan is revisable within its invariants.

- Establish a real, independently testable two-client durable messaging vertical slice before building a dashboard, optional integrations or elaborate scaffolding.
- Inspect current repository state; do not infer missing implementation. Keep worktree ownership explicit. One writer per overlapping scope.
- Reuse established MCP, HTTP, validation and authentication libraries. Keep core domain semantics independent of framework, provider and transport; prefer narrow adapters.
- Add tests alongside behavior. Test with fake clocks/fault injection and a real persisted database; prove both storage profiles. Record actual command outputs and limitations. Never claim delivery, wake, security or compatibility from mock-only evidence.
- No secrets, real workshop messages, private logs or live identifiers in this public repository. Use fictional fixtures. Do not provision paid services, deploy publicly, or migrate an existing board without explicit approval.
- Commit coherent tested slices and push your own review branch. Maintain a short resumable checkpoint where necessary. Escalate real blockers and consequential tradeoffs; continue authorized unblocked work without waiting for prompts.
- Preserve lean economics and predictable recovery above speculative features. Independent adversarial review before production acceptance.
