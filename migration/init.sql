CREATE TABLE IF NOT EXISTS symbols (
  symbol TEXT PRIMARY KEY,
  base TEXT,
  quote TEXT,
  status TEXT,
  updated_at BIGINT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS klines (
  symbol TEXT,
  timeframe TEXT,
  open_time BIGINT,
  open DOUBLE PRECISION,
  high DOUBLE PRECISION,
  low DOUBLE PRECISION,
  close DOUBLE PRECISION,
  volume DOUBLE PRECISION,
  PRIMARY KEY (symbol, timeframe, open_time)
);

CREATE TABLE IF NOT EXISTS signals (
  id SERIAL PRIMARY KEY,
  symbol TEXT,
  timeframe TEXT,
  decision TEXT,
  reason TEXT,
  custom_score INTEGER,
  tv_score INTEGER,
  mtf_status TEXT,
  status TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mtf_state (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  state TEXT,
  last_updated BIGINT DEFAULT 0,
  PRIMARY KEY (symbol, timeframe)
);

CREATE TABLE IF NOT EXISTS mtf_events (
  id SERIAL PRIMARY KEY,
  symbol TEXT,
  timeframe TEXT,
  previous_state TEXT,
  current_state TEXT,
  event_time BIGINT
);

CREATE TABLE IF NOT EXISTS open_trades (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,
  side TEXT,
  status TEXT,
  entry_price DOUBLE PRECISION,
  stop_loss DOUBLE PRECISION,
  take_profit DOUBLE PRECISION,
  trailing_stop DOUBLE PRECISION,
  score INTEGER,
  created_at BIGINT,
  updated_at BIGINT
);

CREATE TABLE IF NOT EXISTS trade_events (
  id SERIAL PRIMARY KEY,
  trade_id INTEGER,
  symbol TEXT,
  kind TEXT,
  payload TEXT,
  created_at BIGINT
);
