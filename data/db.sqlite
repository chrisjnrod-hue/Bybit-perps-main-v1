const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'db.sqlite');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS symbols (
    symbol TEXT PRIMARY KEY,
    base TEXT,
    quote TEXT,
    status TEXT,
    updated_at INTEGER DEFAULT 0
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS klines (
    symbol TEXT,
    timeframe TEXT,
    open_time INTEGER,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    volume REAL,
    PRIMARY KEY (symbol, timeframe, open_time)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT,
    timeframe TEXT,
    decision TEXT,
    reason TEXT,
    custom_score INTEGER,
    tv_score INTEGER,
    mtf_status TEXT,
    status TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS mtf_state (
    symbol TEXT PRIMARY KEY,
    timeframe TEXT,
    state TEXT,
    last_updated INTEGER DEFAULT 0
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS mtf_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT,
    timeframe TEXT,
    previous_state TEXT,
    current_state TEXT,
    event_time INTEGER
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS open_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT,
    side TEXT,
    status TEXT,
    entry_price REAL,
    stop_loss REAL,
    take_profit REAL,
    trailing_stop REAL,
    score INTEGER,
    created_at INTEGER,
    updated_at INTEGER
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS trade_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER,
    symbol TEXT,
    kind TEXT,
    payload TEXT,
    created_at INTEGER
  );
`);

function upsertSymbol(symbol, base, quote, status = 'active') {
  db.prepare(`
    INSERT INTO symbols (symbol, base, quote, status, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET
      base = excluded.base,
      quote = excluded.quote,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(symbol, base, quote, status, Date.now());
}

function saveKline(symbol, timeframe, candle) {
  if (!symbol || !timeframe || !candle) return;

  db.prepare(`
    INSERT INTO klines (symbol, timeframe, open_time, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, timeframe, open_time) DO UPDATE SET
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume = excluded.volume
  `).run(
    symbol,
    timeframe,
    Number(candle.open_time || 0),
    Number(candle.open || 0),
    Number(candle.high || 0),
    Number(candle.low || 0),
    Number(candle.close || 0),
    Number(candle.volume || 0)
  );
}

function saveKlines(symbol, timeframe, candles = []) {
  for (const candle of candles) {
    saveKline(symbol, timeframe, candle);
  }
}

function getSymbols() {
  return db.prepare(`SELECT * FROM symbols ORDER BY symbol ASC`).all();
}

function getLatestCandles(symbol, timeframe, limit = 200) {
  return db.prepare(`
    SELECT *
    FROM klines
    WHERE symbol = ? AND timeframe = ?
    ORDER BY open_time DESC
    LIMIT ?
  `).all(symbol, timeframe, limit).reverse();
}

function setMtfState(symbol, timeframe, state) {
  const prev = db.prepare(`SELECT * FROM mtf_state WHERE symbol = ?`).get(symbol);

  if (prev && prev.state !== state) {
    db.prepare(`
      INSERT INTO mtf_events (symbol, timeframe, previous_state, current_state, event_time)
      VALUES (?, ?, ?, ?, ?)
    `).run(symbol, timeframe, prev.state || 'unknown', state, Date.now());
  }

  db.prepare(`
    INSERT INTO mtf_state (symbol, timeframe, state, last_updated)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET
      timeframe = excluded.timeframe,
      state = excluded.state,
      last_updated = excluded.last_updated
  `).run(symbol, timeframe, state, Date.now());
}

function getMtfState(symbol) {
  return db.prepare(`SELECT * FROM mtf_state WHERE symbol = ?`).get(symbol);
}

function listOpenTrades() {
  return db.prepare(`SELECT * FROM open_trades WHERE status = 'open' ORDER BY created_at DESC`).all();
}

function saveOpenTrade(trade) {
  const existing = db.prepare(`SELECT * FROM open_trades WHERE symbol = ? AND status = 'open' LIMIT 1`).get(trade.symbol);

  if (existing) {
    db.prepare(`
      UPDATE open_trades
      SET side = ?, entry_price = ?, stop_loss = ?, take_profit = ?, trailing_stop = ?, score = ?, updated_at = ?
      WHERE id = ?
    `).run(
      trade.side,
      trade.entry_price,
      trade.stop_loss,
      trade.take_profit,
      trade.trailing_stop,
      trade.score,
      Date.now(),
      existing.id
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO open_trades (symbol, side, entry_price, stop_loss, take_profit, trailing_stop, status, score, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
  `).run(
    trade.symbol,
    trade.side,
    trade.entry_price,
    trade.stop_loss,
    trade.take_profit,
    trade.trailing_stop,
    trade.score,
    Date.now(),
    Date.now()
  );

  return result.lastInsertRowid;
}

function updateOpenTradeStatus(symbol, newStatus, reason = '') {
  db.prepare(`
    UPDATE open_trades
    SET status = ?,
        updated_at = ?
    WHERE symbol = ? AND status = 'open'
  `).run(newStatus, Date.now(), symbol);

  if (reason) {
    db.prepare(`
      INSERT INTO trade_events (trade_id, symbol, kind, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      null,
      symbol,
      'status_change',
      JSON.stringify({ status: newStatus, reason }),
      Date.now()
    );
  }
}

function recordSignal(signal) {
  db.prepare(`
    INSERT INTO signals (symbol, timeframe, decision, reason, custom_score, tv_score, mtf_status, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    signal.symbol,
    signal.timeframe || 'D',
    signal.decision || 'monitor',
    signal.reason || 'n/a',
    Number(signal.customScore || 0),
    Number(signal.tvScore || 0),
    signal.mtfStatus || 'neutral',
    signal.status || 'pending'
  );
}

function getSignalHistory(symbol) {
  return db.prepare(`
    SELECT * FROM signals
    WHERE symbol = ?
    ORDER BY id DESC
    LIMIT 50
  `).all(symbol);
}

module.exports = {
  db,
  upsertSymbol,
  saveKline,
  saveKlines,
  getSymbols,
  getLatestCandles,
  setMtfState,
  getMtfState,
  recordSignal,
  getSignalHistory,
  listOpenTrades,
  saveOpenTrade,
  updateOpenTradeStatus
};
