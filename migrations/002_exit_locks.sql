-- Exit locks: crash-safe replacement for in-memory exitingPositions Set.
-- Keyed by position ID so locks survive restart. Stale locks from a crashed
-- process are cleaned up by the reconciliation loop (Patch 3).
CREATE TABLE IF NOT EXISTS exit_locks (
  position_id INT NOT NULL REFERENCES positions(id),
  lock_type TEXT NOT NULL,          -- 'evaluate', 'partial_stage1', etc.
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (position_id, lock_type)
);

-- Partial-exit intent log: records intent BEFORE swap so incomplete partials
-- are detectable on restart. status: 'pending' -> 'completed' | 'failed'.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS pending_partial JSONB DEFAULT NULL;
