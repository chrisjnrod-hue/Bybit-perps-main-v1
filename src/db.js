const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.DB_SSL ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function upsertSymbol(symbol, base, quote, status = 'active') {
  await pool.query(
    `
    INSERT INTO symbols (symbol, base, quote, status, updated_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (symbol) DO UPDATE SET
      base = EXCLUDED.base,
      quote = EXCLUDED.quote,
      status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at
    `,
    [symbol, base, quote, status, Date.now()]
  );
}

async function saveKline(symbol, timeframe, candle) {
  if (!symbol || !timeframe || !candle) return;

  await pool.query(
    `
    INSERT INTO klines (symbol, timeframe, open_time, open, high, low, close, volume)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (symbol, timeframe, open_time) DO UPDATE SET
      open = EXCLUDED.open,
      high = EXCLUDED.high,
      low = EXCLUDED.low,
      close = EXCLUDED.close,
      volume = EXCLUDED.volume
    `,
    [
      symbol,
      timeframe,
      Number(candle.open_time || 0),
      Number(candle.open || 0),
      Number(candle.high || 0),
      Number(candle.low || 0),
      Number(candle.close || 0),
      Number(candle.volume || 0)
    ]
  );
}

async function saveKlines(symbol, timeframe, candles = []) {
  for (const candle of candles) {
    await saveKline(symbol, timeframe, candle);
  }
}

async function getLatestCandles(symbol, timeframe, limit = 200) {
  const result = await pool.query(
    `
    SELECT *
    FROM klines
    WHERE symbol = $1 AND timeframe = $2
    ORDER BY open_time ASC
    LIMIT $3
    `,
    [symbol, timeframe, limit]
  );

  return result.rows;
}

async function listOpenTrades() {
  const result = await pool.query(
    `
    SELECT *
    FROM open_trades
    WHERE status = 'open'
    ORDER BY created_at DESC
    `
  );

  return result.rows;
}

async function recordSignal(signal) {
  await pool.query(
    `
    INSERT INTO signals (symbol, timeframe, decision, reason, custom_score, tv_score, mtf_status, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      signal.symbol,
      signal.timeframe || 'D',
      signal.decision || 'monitor',
      signal.reason || 'n/a',
      Number(signal.customScore || 0),
      Number(signal.tvScore || 0),
      signal.mtfStatus || 'neutral',
      signal.status || 'pending'
    ]
  );
}

module.exports = {
  query,
  pool,
  upsertSymbol,
  saveKline,
  saveKlines,
  getLatestCandles,
  listOpenTrades,
  recordSignal
};
