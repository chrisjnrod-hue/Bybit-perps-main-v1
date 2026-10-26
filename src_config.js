require('dotenv').config();

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;

  return fallback;
}

function toArray(value, fallback = []) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

module.exports = {
  env: process.env.NODE_ENV || 'development',

  app: {
    port: toNumber(process.env.PORT, 3000),
    logLevel: process.env.LOG_LEVEL || 'info',
    enableKeepalivePing: toBoolean(process.env.ENABLE_KEEPALIVE_PING, true),
  },

  bybit: {
    restBase: process.env.BYBIT_REST_BASE || 'https://api.bybit.com',
    restBases: process.env.BYBIT_REST_BASES || 'https://api.bybit.com',
    orderBase: process.env.BYBIT_ORDER_BASE || '',
    apiKey: process.env.BYBIT_API_KEY || '',
    apiSecret: process.env.BYBIT_API_SECRET || '',
    useTestnet: toBoolean(process.env.BYBIT_USE_TESTNET, false),
    mainnet: toBoolean(process.env.MAINNET, true),
    restTimeoutMs: toNumber(process.env.BYBIT_REST_TIMEOUT_MS, 7000),
    paginationLimit: toNumber(process.env.BYBIT_PAGINATION_LIMIT, 500),
    pageSize: toNumber(process.env.PAGE_SIZE, 50),
  },

  ws: {
    enabled: toBoolean(process.env.USE_WS, true),
    publicUrl: process.env.BYBIT_WS_PUBLIC || 'wss://stream.bybit.com/v5/public/linear',
    maxConcurrent: toNumber(process.env.MAX_CONCURRENT_WS, 12),
    batchSize: toNumber(process.env.BATCH_WS_SIZE, 6),
    subscribeChunk: toNumber(process.env.WS_SUBSCRIBE_CHUNK, 6),
    initialScanTimeout: toNumber(process.env.WS_INITIAL_SCAN_TIMEOUT, 8000),
    connectTimeoutMs: toNumber(process.env.WS_CONNECT_TIMEOUT_MS, 12000),
    reconnectDelayMs: toNumber(process.env.WS_RECONNECT_DELAY_MS, 800),
    reconnectBackoffFactor: toNumber(process.env.WS_RECONNECT_BACKOFF_FACTOR, 2),
    reconnectMaxMs: toNumber(process.env.WS_RECONNECT_MAX_MS, 24000),
    maxReconnectAttempts: toNumber(process.env.WS_MAX_RECONNECT_ATTEMPTS, 8),
  },

  data: {
    seedKlinesLimit: toNumber(process.env.SEED_KLINES_LIMIT, 120),
    seedConcurrency: toNumber(process.env.SEED_CONCURRENCY, 4),
    symbolSeedAll: toBoolean(process.env.SYMBOL_SEED_ALL, true),
    excludeStables: toArray(process.env.EXCLUDE_STABLES, ['USDT', 'USDC', 'TUSD', 'DAI']),
    symbolFilter: process.env.SYMBOL_FILTER || '^[A-Z0-9]+USDT(\\.P)?$',
  },

  mtf: {
    timeframes: toArray(process.env.MTF_TFS, ['5', '15', '60', '240', 'D']),
  },

  trading: {
    defaultAccountEquityUsd: toNumber(process.env.DEFAULT_ACCOUNT_EQUITY_USD, 10000),
    targetPositionFrac: toNumber(process.env.TARGET_POSITION_FRAC, 0.01),
    maxOpenTrades: toNumber(process.env.MAX_OPEN_TRADES, 3),
    defaultLeverage: toNumber(process.env.DEFAULT_LEVERAGE, 3),
    defaultTpPercent: toNumber(process.env.DEFAULT_TP_PERCENT, 3),
    defaultSlPercent: toNumber(process.env.DEFAULT_SL_PERCENT, 1.5),
    spreadPercent: toNumber(process.env.SPREAD_PERCENT, 0.05),
    slippagePercent: toNumber(process.env.SLIPPAGE_PERCENT, 0.1),
    minTvRating: toNumber(process.env.MIN_TV_RATING, 0.6),
    maxConsecutiveRootSignals1d: toNumber(process.env.MAX_CONSECUTIVE_ROOT_SIGNALS_1D, 2),
    enableOpenTrades: toBoolean(process.env.ENABLE_OPEN_TRADES, false),
  },

  risk: {
    breakEvenMode: process.env.BREAK_EVEN_MODE || 'off',
    breakEvenActive: toBoolean(process.env.BREAK_EVEN_ACTIVE, false),
    breakEvenTrailing: toBoolean(process.env.BREAK_EVEN_TRAILING, false),
    breakEvenTriggerPercent: toNumber(process.env.BREAK_EVEN_TRIGGER_PERCENT, 1),
    breakEvenPercent: toNumber(process.env.BREAK_EVEN_PERCENT, 0.5),
    trailingLookback: toNumber(process.env.TRAILING_LOOKBACK, 3),
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    sendDelayMs: toNumber(process.env.TELEGRAM_SEND_DELAY_MS, 250),
    pushFull: toBoolean(process.env.TELEGRAM_PUSH_FULL, false),
    alignmentConfirmationAlert: toBoolean(process.env.ALIGNMENT_CONFIRMATION_ALERT, true),
  },

  keepalive: {
    url: process.env.KEEPALIVE_URL || '',
    intervalMs: toNumber(process.env.KEEPALIVE_INTERVAL_MS, 300000),
  },

  closeLeastProfitable: {
    enabled: toBoolean(process.env.CLOSE_LEAST_PROFITABLE_ENABLED, false),
    minsBeforeBoundary: toNumber(process.env.CLOSE_LEAST_PROFITABLE_MINS_BEFORE_BOUNDARY, 5),
  },

  tradingview: {
    ratingEndpoint: process.env.TRADINGVIEW_RATING_ENDPOINT || '',
    ratingEnabled: toBoolean(process.env.TRADINGVIEW_RATING_ENABLED, false),
  },
};