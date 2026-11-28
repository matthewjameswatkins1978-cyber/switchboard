# Sweep — optional work lifecycle and reconciliation (SWB-SWEEP-001, S1–S3 slice)

Sweep is an **optional coordination layer** over the durable messaging already in
Switchboard. It records who owns an obligation and what happened to it. It is not
a task-orchestration platform, a scheduler, a dashboard framework or a database
rewrite, and it contains no model, inference call or polling loop.

Transport state (`STORED` / `RECEIVED` / `ACKNOWLEDGED` / `DEAD_LETTER`) and work
state are deliberately independent. Acknowledgement is a receipt, never
acceptance, and a delivery ageing out never resolves work.

## What exists today

- `work_items` and `work_events` (additive migration `0002_work_records.sql`, also
  folded into `src/db/schema.ts`): one current row per obligation plus an
  append-only history/receipt log.
- `src/work/` — a narrow domain module (`WorkService`), zod validation, MCP tools
  and an HTTP surface. No transport semantics were changed.
- Both storage profiles are exercised by the same tests: SQLite (self-hosted) and
  the D1 adapter over a D1-shaped test double.

## Invariants

1. Age alone never invalidates work. Nothing in this layer expires an obligation.
2. Delivery state never determines work state; acknowledgement never resolves work.
3. Every consequential change carries an authenticated actor, a reason, an
   expected revision and a durable receipt in `work_events`.
4. Replaying an operation id returns the original receipt. It never duplicates or
   reverses a disposition.
5. A guarded state change and its history row share one predicate, so a stale
   revision or insufficient authority writes **nothing**.
6. Supersession commits the replacement and the disposition together. A
   supersession whose target moved is refused with no orphaned closure.
7. Archival is logical (`archived_at`). Records, evidence, resolution and history
   stay retrievable; reopening is an authorised, recorded transition that keeps the
   prior resolution in history.
8. Nothing is deleted, and no external process, branch or worktree is ever
   terminated by this layer.

## Lifecycle

```
UNCLAIMED -> CLAIMED -> IN_PROGRESS -> WAITING/BLOCKED -> SUBMITTED -> REVIEW -> RESOLVED
```

Terminal reasons stay distinguishable: `COMPLETED`, `SUPERSEDED`, `OBSOLETE`,
`CANCELLED`, `DUPLICATE`. `COMPLETED` requires a submission first. `RESOLVED` is
reopened explicitly, never silently.

## Authority

Authority is evaluated on the server, below the model, from the authenticated
principal and the stored record:

| Action | Who |
|---|---|
| Commission, claim unclaimed work | Any principal with the `write` scope in the project |
| Execution transitions (in progress, waiting, blocked, submitted) | Assigned executor, or project steward |
| Review, accept, request rework | Commissioner or project steward |
| Resolve, supersede, transfer, stop request, reopen, archive | Commissioner or project steward |
| Propose release | Executor (proposal only; the obligation stands) |
| Read work, list, board, related candidates | Any project member |

A steward is `role: admin` **plus** `write` scope, scoped to that principal's own
project by its credential. Being described as a steward elsewhere grants nothing,
and another project's work ids are not visible (`NOT_FOUND`).

## Working with it

- Commission `work` with a stable id and `operationId`, optional `scopeRefs`,
  acceptance criteria, dependencies and a `supersedesWorkId`.
- The commission response includes bounded `relatedCandidates` for outstanding
  work the commissioner has authority over, with deterministic match reasons
  (same thread, shared scope refs, shared objective terms). Candidate selection
  ranks field overlap; it never asserts that two assignments are equivalent.
  When related candidates exist and none is superseded, the record carries
  `reconciliationDeferred = 1`, which is what the board's reconciliation section
  surfaces. Urgent work may proceed with that marker.
- A stop request is recorded, not executed: `stopRequestedAt`/`stopReason` plus a
  history event. The executor answers with `recordStopHandoff`, which preserves
  partial work as state plus evidence handles and leaves the record unresolved.
- `transfer` moves responsibility explicitly and audits both sides; an absent or
  replaced agent's obligation therefore stays recoverable.

Domain methods live on `WorkService` (`src/work/work-service.ts`); the same
operations are exposed as MCP tools (`commission_work`, `claim_work`,
`update_work`, `resolve_work`, `supersede_work`, `request_work_stop`,
`record_work_stop_handoff`, `transfer_work`, `propose_work_release`,
`reopen_work`, `archive_work`, `list_work`, `get_work`, `get_work_board`,
`related_work`, `record_reconciliation`, `transfer_commissionership`)
and over HTTP under `/api/v1/work`, `/api/v1/work-board`,
`/api/v1/work/:id` and `/api/v1/work/:id/<action>`
(`reconcile`, `transfer-commission`).

## Consolidation repairs (SWB-CONSOLIDATE-001 Phase C)

Independent review of `cada310` found six issues; the high and medium ones
are repaired on this branch, with regression tests in
`tests/integration/work-consolidation-repairs.test.ts`:

- **C1 (active-work closure):** `resolve` now refuses with `CONFLICT` while a
  stop request is pending and no handoff is recorded, whenever an executor
  still owns the work. Unclaimed work may still resolve directly. Transferring
  the work does not waive the handoff.
- **C2 (idempotency and receipts):** every mutating operation binds its
  operation id to a canonical content hash (`operation_hash`, migration
  `0003_work_event_receipts.sql`). A replay with different content is a
  `CONFLICT`, never an accepted replay. A replay by anyone other than the
  original actor must pass the fresh operation's authority check first;
  otherwise it is `FORBIDDEN` with no receipt. Receipts now carry the reason
  snapshotted at commit time (`resulting_resolution_reason`), so history
  stays stable across later reopening, transfer or re-resolution.
  Internally derived ids (`<op>:supersede`) are hash-bound the same way.
  Events committed before migration 0003 carry NULL in the new columns;
  their receipts report a NULL reason rather than borrowing the work's
  current reason, so pre-migration history is never misattributed.
  `stopHandoffAt`, once recorded, is never cleared or nulled by any later
  operation: the C1 gate depends on it permanently distinguishing
  "stopped and handed off" from "stopped and still owned".
- **C3 (commissioner succession):** `transferCommissionership` moves the
  commissioner's responsibility explicitly (commissioner or steward only,
  target must exist, revision-guarded, receipted). A departing model no
  longer strands its commissions.
- **C4 (reconciliation correctness):** `relatedWork` now returns the true
  uncapped `outstandingCount` plus an explicit `truncated` flag, so omitted
  candidates are visible instead of silent. `resolveReconciliation` records
  the commissioner's decision (`retained | reprioritised | combined |
  superseded | withdrawn | cancelled | referred`) as a revision-guarded
  event and clears the deferred marker.
- **C6 (hosted storage and recovery):** `exportData`/`importData` (and
  therefore scheduled backups and restore) include `workItems` and
  `workEvents` with their receipt columns. Pre-Sweep exports restore
  cleanly; databases pre-dating the work tables export without work data.
  Migration `0003` upgrades existing databases and backfills resolved
  reasons; fresh databases get the columns from `SCHEMA_SQL` directly.
- **C5 (lifecycle and authority):** reviewed without code change. Steward
  scope (`admin` role plus `write` scope on the caller's own project
  credential) is sound; no universal access exists. Transition rules,
  executor/commissioner separation, evidence handling, cycle prevention
  and archive access hold as specified.

## What this slice does not do

- No Doorbell dispatch, wake policy or host adapter integration (S4). Pending work
  stays recoverable through ordinary sync; nothing here depends on a wake.
- No backlog migration, bulk acknowledgement or destructive cleanup (S5). Existing
  messages are untouched and no existing prose is treated as a work record.
- No load qualification at 10/50 endpoints beyond bounded-query evidence, and no
  independent adversarial review or real-workshop trial (S6).
- No housekeeping changes: `runHousekeeping` still ages deliveries, and work
  records are intentionally outside its scope.

## Evidence

`tests/integration/work-lifecycle.test.ts`, `tests/integration/work-portability.test.ts`,
`tests/integration/work-surfaces.test.ts` and `tests/adversarial/sweep-terrorbat.test.ts`
exercise the acceptance behaviours against real persisted state, including
idempotent replay, concurrent conflicting writes, an age-expired delivery that
leaves the obligation active, logical archival with reopening, bounded board/list
queries over 200 work items and 120 deliveries, and unchanged messaging beside the
work surface.
