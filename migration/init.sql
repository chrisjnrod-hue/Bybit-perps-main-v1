-- =========================================
-- Base tables
-- =========================================

CREATE TABLE IF NOT EXISTS symbols (
  symbol TEXT PRIMARY KEY,
  base TEXT NOT NULL,
  quote TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS klines (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  open_time BIGINT NOT NULL,
  open DOUBLE PRECISION NOT NULL DEFAULT 0,
  high DOUBLE PRECISION NOT NULL DEFAULT 0,
  low DOUBLE PRECISION NOT NULL DEFAULT 0,
  close DOUBLE PRECISION NOT NULL DEFAULT 0,
  volume DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, timeframe, open_time)
);

CREATE TABLE IF NOT EXISTS open_trades (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,
  side TEXT NOT NULL DEFAULT 'buy',
  status TEXT NOT NULL DEFAULT 'open',
  entry_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  stop_loss DOUBLE PRECISION NOT NULL DEFAULT 0,
  take_profit DOUBLE PRECISION NOT NULL DEFAULT 0,
  trailing_stop DOUBLE PRECISION NOT NULL DEFAULT 0,
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

-- =========================================
-- Signals table
-- =========================================
CREATE TABLE IF NOT EXISTS signals (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT 'D',
  decision TEXT NOT NULL DEFAULT 'monitor',
  reason TEXT NOT NULL DEFAULT 'n/a',
  custom_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  tv_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  mtf_status TEXT NOT NULL DEFAULT 'neutral',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL DEFAULT 0,
  daily_candle_time BIGINT DEFAULT 0
);

-- Safely add columns if they don't exist
ALTER TABLE signals ADD COLUMN IF NOT EXISTS daily_candle_time BIGINT;

-- Handle potential data type mismatch on created_at for existing tables
DO $$ 
BEGIN
  BEGIN
    ALTER TABLE signals ALTER COLUMN created_at TYPE BIGINT USING EXTRACT(EPOCH FROM created_at)::BIGINT;
  EXCEPTION WHEN others THEN
    NULL;
  END;
END $$;

UPDATE signals
SET daily_candle_time = 0
WHERE daily_candle_time IS NULL;

UPDATE signals
SET created_at = 0
WHERE created_at IS NULL;

-- Deduplicate rows that would conflict with the unique index.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY symbol, timeframe, daily_candle_time
      ORDER BY created_at DESC, id DESC
    ) AS row_num
  FROM signals
  WHERE daily_candle_time IS NOT NULL
)
DELETE FROM signals s
USING ranked r
WHERE s.id = r.id
  AND r.row_num > 1;

CREATE UNIQUE INDEX IF NOT EXISTS signals_symbol_timeframe_daily_candle_uq
  ON signals (symbol, timeframe, daily_candle_time);

CREATE INDEX IF NOT EXISTS signals_symbol_timeframe_idx
  ON signals (symbol, timeframe);

CREATE INDEX IF NOT EXISTS signals_created_at_idx
  ON signals (created_at DESC);

-- =========================================
-- MTF tables
-- =========================================
CREATE TABLE IF NOT EXISTS mtf_state (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  state TEXT NOT NULL,
  last_updated BIGINT NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);

CREATE TABLE IF NOT EXISTS mtf_events (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  previous_state TEXT NOT NULL DEFAULT 'none',
  current_state TEXT NOT NULL,
  event_time BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS mtf_events_symbol_timeframe_idx
  ON mtf_events (symbol, timeframe, event_time DESC);

-- =========================================
-- Scan run tracking
-- =========================================
CREATE TABLE IF NOT EXISTS scan_runs (
  id BIGSERIAL PRIMARY KEY,
  run_key TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT 'D',
  daily_candle_time BIGINT NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT 'n/a',
  created_at BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS scan_runs_symbol_timeframe_idx
  ON scan_runs (symbol, timeframe, daily_candle_time);
