-- SWB-SWEEP-001 (S1) — optional work lifecycle layer.
-- Additive only: no existing table, column or row is modified or removed.
-- Work state is independent of transport delivery state. Nothing here is deleted;
-- archival is a logical flag and historical rows stay retrievable.

CREATE TABLE IF NOT EXISTS work_items (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('UNCLAIMED', 'CLAIMED', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'SUBMITTED', 'REVIEW', 'RESOLVED')),
  resolution_reason TEXT CHECK (resolution_reason IN ('COMPLETED', 'SUPERSEDED', 'OBSOLETE', 'CANCELLED', 'DUPLICATE')),
  priority TEXT NOT NULL CHECK (priority IN ('urgent', 'normal', 'low')),
  objective TEXT NOT NULL,
  scope_refs TEXT,
  acceptance_criteria TEXT,
  evidence_refs TEXT,
  depends_on TEXT,
  commissioner_id TEXT NOT NULL,
  commissioner_role TEXT NOT NULL,
  executor_id TEXT,
  claimed_at INTEGER,
  submitted_at INTEGER,
  resolved_at INTEGER,
  resolved_by TEXT,
  thread_id TEXT,
  source_message_id TEXT,
  replaces_work_id TEXT,
  superseded_by_work_id TEXT,
  stop_requested_at INTEGER,
  stop_requested_by TEXT,
  stop_reason TEXT,
  stop_handoff_at INTEGER,
  reconciliation_deferred INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  last_event_seq INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_work_items_state
  ON work_items(project_id, archived_at, state, priority);
CREATE INDEX IF NOT EXISTS idx_work_items_executor
  ON work_items(project_id, executor_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_work_items_commissioner
  ON work_items(project_id, commissioner_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_work_items_keyset
  ON work_items(project_id, created_at, id);

-- Append-only history and durable receipts. One row per accepted operation.
-- UNIQUE(project_id, operation_id) makes replayed operations return the original
-- receipt instead of duplicating or reversing a disposition.
CREATE TABLE IF NOT EXISTS work_events (
  project_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  reason TEXT,
  note TEXT,
  evidence_refs TEXT,
  operation_id TEXT NOT NULL,
  expected_revision INTEGER,
  resulting_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, work_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_events_operation
  ON work_events(project_id, operation_id);
CREATE INDEX IF NOT EXISTS idx_work_events_work
  ON work_events(project_id, work_id, seq);
