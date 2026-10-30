CREATE UNIQUE INDEX IF NOT EXISTS open_trades_symbol_uq
ON open_trades(symbol);

ALTER TABLE mtf_state
  DROP CONSTRAINT IF EXISTS mtf_state_pkey;

ALTER TABLE mtf_state
  ADD PRIMARY KEY (symbol, timeframe);
