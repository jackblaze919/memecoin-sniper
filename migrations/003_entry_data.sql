-- Add entry_data JSONB column to positions for score-validation analysis.
-- Stores sub-scores, pair age, holder concentration, Birdeye presence, etc.
-- Backward-compatible: old rows have NULL entry_data.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_data JSONB;
