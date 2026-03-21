CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  pair_address TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_scored_at TIMESTAMPTZ,
  total_score REAL,
  discovery_score REAL,
  flow_score REAL,
  mispricing_score REAL,
  safety_score REAL,
  anti_fomo_rejected BOOLEAN DEFAULT FALSE,
  anti_fomo_reason TEXT,
  safety_gate_passed BOOLEAN DEFAULT FALSE,
  holder_count INT,
  liquidity_usd REAL,
  market_cap_usd REAL,
  price_usd REAL,
  volume_24h REAL,
  data JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS positions (
  id SERIAL PRIMARY KEY,
  token_address TEXT NOT NULL,
  symbol TEXT,
  entry_price REAL,
  entry_amount_sol REAL,
  entry_amount_tokens REAL,
  entry_score REAL,
  entry_reason TEXT,
  entry_tx TEXT,
  entry_timestamp TIMESTAMPTZ DEFAULT NOW(),
  current_price REAL,
  current_pnl_pct REAL,
  holder_count_at_entry INT,
  liquidity_at_entry REAL,
  status TEXT DEFAULT 'open',
  exit_price REAL,
  exit_reason TEXT,
  exit_tx TEXT,
  exit_timestamp TIMESTAMPTZ,
  final_pnl_sol REAL,
  final_pnl_pct REAL,
  hold_time_minutes REAL,
  partial_exits JSONB DEFAULT '[]',
  mode TEXT DEFAULT 'paper'
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_token ON positions(token_address);
CREATE INDEX IF NOT EXISTS idx_positions_entry_ts ON positions(entry_timestamp);

CREATE TABLE IF NOT EXISTS daily_stats (
  date DATE PRIMARY KEY,
  total_trades INT DEFAULT 0,
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  total_pnl_sol REAL DEFAULT 0,
  total_pnl_usd REAL DEFAULT 0,
  tokens_scanned INT DEFAULT 0,
  tokens_bought INT DEFAULT 0,
  daily_loss_limit_hit BOOLEAN DEFAULT FALSE,
  circuit_breaker_triggered BOOLEAN DEFAULT FALSE,
  birdeye_cus_used INT DEFAULT 0,
  data JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO bot_state (key, value) VALUES
  ('consecutive_losses', '0'),
  ('daily_loss_total', '0'),
  ('paused_until', 'null'),
  ('last_trade_at', 'null'),
  ('trading_mode', '"scanner"')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS trade_locks (
  token_address TEXT NOT NULL,
  date DATE NOT NULL,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (token_address, date, action)
);

CREATE INDEX IF NOT EXISTS idx_trade_locks_date ON trade_locks(date);
