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

CREATE INDEX IF NOT EXISTS klines_symbol_timeframe_open_time_idx
  ON klines (symbol, timeframe, open_time);

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

CREATE INDEX IF NOT EXISTS open_trades_status_created_at_idx
  ON open_trades (status, created_at DESC);

CREATE TABLE IF NOT EXISTS signals (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT 'D',
  daily_candle_time BIGINT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'monitor',
  reason TEXT NOT NULL DEFAULT 'n/a',
  custom_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  tv_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  mtf_status TEXT NOT NULL DEFAULT 'neutral',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  CONSTRAINT signals_symbol_timeframe_candle_uq
    UNIQUE (symbol, timeframe, daily_candle_time)
);

CREATE INDEX IF NOT EXISTS signals_created_at_idx
  ON signals (created_at DESC);

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

CREATE INDEX IF NOT EXISTS mtf_events_symbol_timeframe_event_time_idx
  ON mtf_events (symbol, timeframe, event_time DESC);
