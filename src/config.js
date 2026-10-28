require('dotenv').config();

const parseList = (value, fallback = []) => {
  const source = value === undefined || value === null || value === ''
    ? fallback
    : String(value);

  if (Array.isArray(source)) {
    return source.map(String).map((s) => s.trim()).filter(Boolean);
  }

  return String(source)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

function envBool(name, defaultValue = false) {
  const raw = process.env[name];
  if (typeof raw === 'undefined') return defaultValue;

  const value = String(raw).trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function envInt(name, defaultValue) {
  const raw = process.env[name];
  if (typeof raw === 'undefined') return defaultValue;

  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : defaultValue;
}

function envFloat(name, defaultValue) {
  const raw = process.env[name];
  if (typeof raw === 'undefined') return defaultValue;

  const value = Number(raw);
  return Number.isFinite(value) ? value : defaultValue;
}

function envString(name, defaultValue) {
  const raw = process.env[name];
  if (typeof raw === 'undefined' || raw === null || raw === '') return defaultValue;
  return String(raw);
}

module.exports = {
  // ---------------------------
  // Core exchange / API
  // ---------------------------
  BYBIT_REST_BASE: envString('BYBIT_REST_BASE', 'https://api.bybit.com'),
  BYBIT_WS_PUBLIC: envString('BYBIT_WS_PUBLIC', 'wss://stream.bybit.com/v5/public/linear'),
  BYBIT_API_KEY: process.env.BYBIT_API_KEY || '',
  BYBIT_API_SECRET: process.env.BYBIT_API_SECRET || '',

  // ---------------------------
  // PostgreSQL / Render DB
  // ---------------------------
  DATABASE_URL: process.env.DATABASE_URL || '',
  DB_SSL: process.env.DB_SSL === 'true'
  // ---------------------------
  // Performance / speed tuning
  // ---------------------------
  USE_WS: envBool('USE_WS', true),
  SYMBOL_SEED_ALL: envBool('SYMBOL_SEED_ALL', true),

  MAX_CONCURRENT_WS: envInt('MAX_CONCURRENT_WS', 12),
  BATCH_WS_SIZE: envInt('BATCH_WS_SIZE', 6),
  WS_SUBSCRIBE_CHUNK: envInt('WS_SUBSCRIBE_CHUNK', 6),

  WS_INITIAL_SCAN_TIMEOUT: envInt('WS_INITIAL_SCAN_TIMEOUT', 8000),
  WS_CONNECT_TIMEOUT_MS: envInt('WS_CONNECT_TIMEOUT_MS', 12000),
  WS_RECONNECT_DELAY_MS: envInt('WS_RECONNECT_DELAY_MS', 800),
  WS_RECONNECT_BACKOFF_FACTOR: envFloat('WS_RECONNECT_BACKOFF_FACTOR', 2),
  WS_RECONNECT_MAX_MS: envInt('WS_RECONNECT_MAX_MS', 24000),
  WS_MAX_RECONNECT_ATTEMPTS: envInt('WS_MAX_RECONNECT_ATTEMPTS', 8),
  WS_SUBSCRIBE_RETRY_BASE_MS: envInt('WS_SUBSCRIBE_RETRY_BASE_MS', 800),
  WS_SUBSCRIBE_RETRY_MAX_MS: envInt('WS_SUBSCRIBE_RETRY_MAX_MS', 30000),

  BYBIT_PAGINATION_LIMIT: envInt('BYBIT_PAGINATION_LIMIT', 500),

  SEED_KLINES_LIMIT: envInt('SEED_KLINES_LIMIT', 120),
  SEED_CONCURRENCY: envInt('SEED_CONCURRENCY', 4),
  PAGE_SIZE: envInt('PAGE_SIZE', 50),

  // ---------------------------
  // Symbol filters
  // ---------------------------
  EXCLUDE_STABLES: parseList(process.env.EXCLUDE_STABLES, ['USDT', 'USDC', 'TUSD', 'DAI']),
  SYMBOL_FILTER: envString('SYMBOL_FILTER', '^[A-Z0-9]+USDT(\\.P)?$'),

  // ---------------------------
  // Root / MTF scan config
  // ---------------------------
  MTF_TFS: parseList(process.env.MTF_TFS, ['15', '60', '240', 'D']),

  // ---------------------------
  // Trade settings
  // ---------------------------
  DEFAULT_ACCOUNT_EQUITY_USD: envFloat('DEFAULT_ACCOUNT_EQUITY_USD', 10000),
  TARGET_POSITION_FRAC: envFloat('TARGET_POSITION_FRAC', 0.01),

  MAX_OPEN_TRADES: envInt('MAX_OPEN_TRADES', 3),
  DEFAULT_LEVERAGE: envFloat('DEFAULT_LEVERAGE', 3),

  DEFAULT_TP_PERCENT: envFloat('DEFAULT_TP_PERCENT', 3),
  DEFAULT_SL_PERCENT: envFloat('DEFAULT_SL_PERCENT', 1.5),
  SPREAD_PERCENT: envFloat('SPREAD_PERCENT', 0.05),
  SLIPPAGE_PERCENT: envFloat('SLIPPAGE_PERCENT', 0.1),

  BREAK_EVEN_MODE: envString('BREAK_EVEN_MODE', 'off'),
  BREAK_EVEN_ACTIVE: envBool('BREAK_EVEN_ACTIVE', false),
  BREAK_EVEN_TRAILING: envBool('BREAK_EVEN_TRAILING', false),
  BREAK_EVEN_TRIGGER_PERCENT: envFloat('BREAK_EVEN_TRIGGER_PERCENT', 1),
  BREAK_EVEN_PERCENT: envFloat('BREAK_EVEN_PERCENT', 0.5),
  TRAILING_LOOKBACK: envInt('TRAILING_LOOKBACK', 3),

  // ---------------------------
  // Signal gating / quality
  // ---------------------------
  MIN_TV_RATING: envFloat('MIN_TV_RATING', 0.6),
  MAX_CONSECUTIVE_ROOT_SIGNALS_1D: envInt('MAX_CONSECUTIVE_ROOT_SIGNALS_1D', 2),

  // ---------------------------
  // Telegram / notifications
  // ---------------------------
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

  TELEGRAM_SEND_DELAY_MS: envInt('TELEGRAM_SEND_DELAY_MS', 250),
  TELEGRAM_PUSH_FULL: envBool('TELEGRAM_PUSH_FULL', false),

  ALIGNMENT_CONFIRMATION_ALERT: envBool('ALIGNMENT_CONFIRMATION_ALERT', true),

  // ---------------------------
  // DB / runtime / health
  // ---------------------------
  PORT: envInt('PORT', 3000),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  ENABLE_KEEPALIVE_PING: envBool('ENABLE_KEEPALIVE_PING', true),
  KEEPALIVE_URL: process.env.KEEPALIVE_URL || '',
  KEEPALIVE_INTERVAL_MS: envInt('KEEPALIVE_INTERVAL_MS', 5 * 60 * 1000),

  CLOSE_LEAST_PROFITABLE_ENABLED: envBool('CLOSE_LEAST_PROFITABLE_ENABLED', false),
  CLOSE_LEAST_PROFITABLE_MINS_BEFORE_BOUNDARY: envInt('CLOSE_LEAST_PROFITABLE_MINS_BEFORE_BOUNDARY', 5),

  // ---------------------------
  // Optional / compatibility
  // ---------------------------
  BYBIT_REST_BASES: parseList(process.env.BYBIT_REST_BASES, ['https://api.bybit.com']),
  BYBIT_ORDER_BASE: process.env.BYBIT_ORDER_BASE || '',
  MAINNET: envBool('MAINNET', true),
  BYBIT_USE_TESTNET: envBool('BYBIT_USE_TESTNET', false),

  ENABLE_OPEN_TRADES: envBool('ENABLE_OPEN_TRADES', false),

  // Safety no-op placeholders
  BYBIT_REST_TIMEOUT_MS: envInt('BYBIT_REST_TIMEOUT_MS', 7000),
};
