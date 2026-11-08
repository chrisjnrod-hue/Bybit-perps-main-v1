const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.DB_SSL === true || String(config.DB_SSL).toLowerCase() === 'true'
    ? { rejectUnauthorized: false }
    : false
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

async function listActiveSymbols() {
  const result = await pool.query(
    `SELECT symbol FROM symbols WHERE status = 'active' ORDER BY symbol`
  );
  return result.rows.map((row) => row.symbol);
}

async function saveKline(symbol, timeframe, candle) {
  if (!symbol || !timeframe || !candle) return;

  const openTime = Number(candle.open_time || 0);
  if (!Number.isFinite(openTime) || openTime <= 0) return;

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
      openTime,
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
    FROM (
      SELECT *
      FROM klines
      WHERE symbol = $1 AND timeframe = $2
      ORDER BY open_time DESC
      LIMIT $3
    ) latest
    ORDER BY open_time ASC
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

async function countOpenTrades() {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM open_trades WHERE status = 'open'`
  );
  return Number(result.rows[0]?.count || 0);
}

async function getOpenTradeBySymbol(symbol) {
  const result = await pool.query(
    `
    SELECT *
    FROM open_trades
    WHERE symbol = $1 AND status = 'open'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [symbol]
  );
  return result.rows[0] || null;
}

async function saveOpenTrade(trade) {
  const result = await pool.query(
    `
    INSERT INTO open_trades (
      symbol,
      side,
      status,
      entry_price,
      stop_loss,
      take_profit,
      trailing_stop,
      score,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (symbol) DO UPDATE SET
      side = EXCLUDED.side,
      status = EXCLUDED.status,
      entry_price = EXCLUDED.entry_price,
      stop_loss = EXCLUDED.stop_loss,
      take_profit = EXCLUDED.take_profit,
      trailing_stop = EXCLUDED.trailing_stop,
      score = EXCLUDED.score,
      updated_at = EXCLUDED.updated_at
    RETURNING *
    `,
    [
      trade.symbol,
      trade.side || 'buy',
      trade.status || 'open',
      Number(trade.entryPrice || trade.entry_price || 0),
      Number(trade.stopLoss || trade.stop_loss || 0),
      Number(trade.takeProfit || trade.take_profit || 0),
      Number(trade.trailingStop || trade.trailing_stop || 0),
      Number(trade.score || 0),
      Date.now(),
      Date.now()
    ]
  );
  return result.rows[0];
}

async function updateOpenTradeStatus(symbol, status, reason = null) {
  const sql = reason
    ? `
      UPDATE open_trades
      SET status = $2, updated_at = $3, reason = $4
      WHERE symbol = $1
    `
    : `
      UPDATE open_trades
      SET status = $2, updated_at = $3
      WHERE symbol = $1
    `;

  const params = reason
    ? [symbol, status, Date.now(), reason]
    : [symbol, status, Date.now()];

  await pool.query(sql, params);
}

async function hasRecentSignal(symbol, dailyCandleTime, reason, windowMinutes = 30) {
  const result = await pool.query(
    `
    SELECT 1
    FROM signals
    WHERE symbol = $1
      AND timeframe = 'D'
      AND daily_candle_time = $2
      AND reason = $3
      AND created_at > $4
    LIMIT 1
    `,
    [
      symbol,
      Number(dailyCandleTime || 0),
      String(reason || 'n/a'),
      Date.now() - Number(windowMinutes) * 60 * 1000
    ]
  );
  return result.rowCount > 0;
}

async function recordSignal(signal) {
  await pool.query(
    `
    INSERT INTO signals (
      symbol, timeframe, daily_candle_time, decision, reason,
      custom_score, tv_score, mtf_status, status, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (symbol, timeframe, daily_candle_time) DO UPDATE SET
      decision = EXCLUDED.decision,
      reason = EXCLUDED.reason,
      custom_score = EXCLUDED.custom_score,
      tv_score = EXCLUDED.tv_score,
      mtf_status = EXCLUDED.mtf_status,
      status = EXCLUDED.status,
      created_at = EXCLUDED.created_at
    `,
    [
      signal.symbol,
      signal.timeframe || 'D',
      Number(signal.dailyCandleTime || 0),
      signal.decision || 'monitor',
      signal.reason || 'n/a',
      Number(signal.customScore || 0),
      Number(signal.tvScore || 0),
      signal.mtfStatus || 'neutral',
      signal.status || 'pending',
      Date.now()
    ]
  );
}

async function getMtfState(symbol, timeframe) {
  const result = await pool.query(
    `
    SELECT *
    FROM mtf_state
    WHERE symbol = $1 AND timeframe = $2
    `,
    [symbol, timeframe]
  );
  return result.rows[0] || null;
}

async function saveMtfState(symbol, timeframe, state) {
  await pool.query(
    `
    INSERT INTO mtf_state (symbol, timeframe, state, last_updated)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (symbol, timeframe) DO UPDATE SET
      state = EXCLUDED.state,
      last_updated = EXCLUDED.last_updated
    `,
    [symbol, timeframe, state, Date.now()]
  );
}

async function setMtfState(symbol, timeframe, state) {
  return saveMtfState(symbol, timeframe, state);
}

async function recordMtfEvent(symbol, timeframe, previousState, currentState) {
  await pool.query(
    `
    INSERT INTO mtf_events (symbol, timeframe, previous_state, current_state, event_time)
    VALUES ($1, $2, $3, $4, $5)
    `,
    [symbol, timeframe, previousState || 'none', currentState, Date.now()]
  );
}

async function notificationWasSent(runKey) {
  const result = await pool.query(
    `SELECT 1 FROM scan_runs WHERE run_key = $1 LIMIT 1`,
    [runKey]
  );
  return result.rowCount > 0;
}

async function markNotificationSent(runKey, symbol, dailyCandleTime, reason) {
  await pool.query(
    `
    INSERT INTO scan_runs (run_key, symbol, timeframe, daily_candle_time, reason, created_at)
    VALUES ($1, $2, 'D', $3, $4, $5)
    ON CONFLICT (run_key) DO NOTHING
    `,
    [
      runKey,
      symbol,
      Number(dailyCandleTime || 0),
      String(reason || 'n/a'),
      Date.now()
    ]
  );
}

async function purgeStaleCache() {
  const now = Date.now();
  const signalsCutoff =
    now - Number(config.SIGNALS_RETENTION_MS || 30 * 24 * 60 * 60 * 1000);
  const mtfEventsCutoff =
    now - Number(config.MTF_EVENTS_RETENTION_MS || 7 * 24 * 60 * 60 * 1000);
  const scanRunsCutoff =
    now - Number(config.SCAN_RUNS_RETENTION_MS || 30 * 24 * 60 * 60 * 1000);

  // Retain the newest 200 candles for each symbol/timeframe because indicators
  // require historical candles. This bounds table growth without removing
  // the history needed by the strategy.
  await pool.query(`
    WITH ranked AS (
      SELECT ctid,
        ROW_NUMBER() OVER (
          PARTITION BY symbol, timeframe
          ORDER BY open_time DESC
        ) AS row_num
      FROM klines
    )
    DELETE FROM klines k
    USING ranked r
    WHERE k.ctid = r.ctid
      AND r.row_num > 200
  `);

  await pool.query(`DELETE FROM signals WHERE created_at < $1`, [signalsCutoff]);
  await pool.query(`DELETE FROM mtf_events WHERE event_time < $1`, [mtfEventsCutoff]);
  await pool.query(`DELETE FROM scan_runs WHERE created_at < $1`, [scanRunsCutoff]);

  console.log(`Stale cache cleanup completed at ${new Date(now).toISOString()}`);
}

module.exports = {
  query,
  pool,
  upsertSymbol,
  listActiveSymbols,
  saveKline,
  saveKlines,
  getLatestCandles,
  listOpenTrades,
  countOpenTrades,
  getOpenTradeBySymbol,
  saveOpenTrade,
  updateOpenTradeStatus,
  hasRecentSignal,
  recordSignal,
  getMtfState,
  saveMtfState,
  setMtfState,
  recordMtfEvent,
  notificationWasSent,
  markNotificationSent,
  purgeStaleCache
};
