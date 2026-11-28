-- SWB-CONSOLIDATE-001 Phase C (C2) — stable receipts and operation binding.
-- Additive only: two nullable columns with deterministic backfill.
-- resulting_resolution_reason snapshots the reason at commit time so a
-- receipt never drifts when the work is later reopened or re-resolved.
-- operation_hash binds an operation id to its canonical content so a replay
-- with differing content is a conflict instead of a false accepted replay.

ALTER TABLE work_events ADD COLUMN resulting_resolution_reason TEXT
  CHECK (resulting_resolution_reason IN ('COMPLETED', 'SUPERSEDED', 'OBSOLETE', 'CANCELLED', 'DUPLICATE'));
ALTER TABLE work_events ADD COLUMN operation_hash TEXT;

UPDATE work_events
SET resulting_resolution_reason = reason
WHERE event_type = 'RESOLVED'
  AND reason IN ('COMPLETED', 'SUPERSEDED', 'OBSOLETE', 'CANCELLED', 'DUPLICATE')
  AND resulting_resolution_reason IS NULL;
