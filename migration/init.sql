-- 1) Remove duplicate open_trades rows by symbol, keep the latest one
DELETE FROM open_trades a
USING open_trades b
WHERE a.id < b.id
  AND a.symbol = b.symbol;

-- 2) Ensure open_trades has one row per symbol
CREATE UNIQUE INDEX IF NOT EXISTS open_trades_symbol_uq
ON open_trades(symbol);

-- 3) Fix mtf_state table so it matches ON CONFLICT (symbol, timeframe)
--    If it already has a PK, drop it first
ALTER TABLE mtf_state
  DROP CONSTRAINT IF EXISTS mtf_state_pkey;

ALTER TABLE mtf_state
  ADD PRIMARY KEY (symbol, timeframe);
