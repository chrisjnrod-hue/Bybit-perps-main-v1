-- 1) Ensure the signals table exists with the required columns
CREATE TABLE IF NOT EXISTS signals (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT 'D',
  daily_candle_time BIGINT NOT NULL DEFAULT 0,
  decision TEXT NOT NULL DEFAULT 'monitor',
  reason TEXT NOT NULL DEFAULT 'n/a',
  custom_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  tv_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  mtf_status TEXT NOT NULL DEFAULT 'neutral',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL DEFAULT 0
);

-- 2) Add missing columns if the table already exists
ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS timeframe TEXT DEFAULT 'D';

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS daily_candle_time BIGINT;

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS decision TEXT DEFAULT 'monitor';

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS reason TEXT DEFAULT 'n/a';

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS custom_score DOUBLE PRECISION DEFAULT 0;

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS tv_score DOUBLE PRECISION DEFAULT 0;

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS mtf_status TEXT DEFAULT 'neutral';

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS created_at BIGINT DEFAULT 0;

-- 3) Backfill nulls so existing rows don't explode
UPDATE signals
SET daily_candle_time = 0
WHERE daily_candle_time IS NULL;

UPDATE signals
SET created_at = 0
WHERE created_at IS NULL;

-- 4) Prevent duplicate daily signals for the same symbol/timeframe/candle
CREATE UNIQUE INDEX IF NOT EXISTS signals_symbol_timeframe_daily_candle_uq
  ON signals (symbol, timeframe, daily_candle_time);

-- 5) Fix mtf_state PK to match ON CONFLICT (symbol, timeframe)
ALTER TABLE mtf_state
  DROP CONSTRAINT IF EXISTS mtf_state_pkey;

ALTER TABLE mtf_state
  ADD PRIMARY KEY (symbol, timeframe);

-- 6) Unique open_trades by symbol
DELETE FROM open_trades a
USING open_trades b
WHERE a.id < b.id
  AND a.symbol = b.symbol;

CREATE UNIQUE INDEX IF NOT EXISTS open_trades_symbol_uq
  ON open_trades(symbol);
