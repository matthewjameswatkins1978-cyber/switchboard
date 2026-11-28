-- SWB-CONSOLIDATE-001 Phase C (C1 episode-scoped handoff, Lucy-directed).
-- Additive only: new columns with safe defaults plus a documented backfill.
--
-- Model: every claim, transfer and reopen opens a new execution episode
-- (exec_episode). Stop/handoff markers belong to exactly one episode:
-- a handoff is bound to (episode, stop request, executor). A new stop
-- request, a new episode, or a new executor invalidates any prior handoff.
-- History stays in work_events; only the live markers reset.
--
-- needsHandoff (enforced at guarded mutation for noncompletion closure,
-- conflicting transfer and supersession of active ownership):
--   active ownership  = executor present and state not UNCLAIMED/RESOLVED
--   no-start clean    = never entered IN_PROGRESS in this episode AND no
--                       stop was ever requested (stop_seq = 0, none open)
--   a current handoff satisfies the gate only when
--   handoff_episode = exec_episode AND handoff_stop_seq = stop_seq
--   AND handoff_by = executor_id.

ALTER TABLE work_items ADD COLUMN exec_episode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_items ADD COLUMN stop_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_items ADD COLUMN stop_open INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_items ADD COLUMN handoff_episode INTEGER;
ALTER TABLE work_items ADD COLUMN handoff_stop_seq INTEGER;
ALTER TABLE work_items ADD COLUMN handoff_by TEXT;
ALTER TABLE work_items ADD COLUMN exec_started_episode INTEGER;

-- Backfill legacy rows conservatively. A pending legacy stop stays pending
-- (stop_seq 1, stop open) in episode 0; a recorded legacy handoff keeps its
-- answered stop closed. But a handoff binding is only carried over where no
-- resumed execution could have followed it — i.e. never for live rows,
-- whose history the migration cannot see. Live legacy work therefore needs
-- one fresh handoff under the new rules; RESOLVED rows keep their binding
-- informationally (the gate never applies to resolved work).
UPDATE work_items
SET stop_seq = 1, stop_open = 1
WHERE stop_requested_at IS NOT NULL AND stop_handoff_at IS NULL;

UPDATE work_items
SET stop_seq = 1,
    stop_open = 0
WHERE stop_handoff_at IS NOT NULL;

UPDATE work_items
SET handoff_episode = 0,
    handoff_stop_seq = 1,
    handoff_by = COALESCE(executor_id, stop_requested_by)
WHERE stop_handoff_at IS NOT NULL AND state = 'RESOLVED';

UPDATE work_items
SET exec_started_episode = 0
WHERE state IN ('IN_PROGRESS', 'WAITING', 'BLOCKED', 'SUBMITTED', 'REVIEW');
