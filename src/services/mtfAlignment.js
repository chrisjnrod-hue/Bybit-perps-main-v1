const { macdHistogram } = require('./macd');

const REQUIRED_MTF_TFS = ['5', '15', '60', '240'];
const TF_ORDER = {
  '5': 1,
  '15': 2,
  '60': 3,
  '240': 4
};

function getHistogram(candles, options = {}) {
  if (!Array.isArray(candles) || candles.length < 26) {
    return null;
  }

  const value = Number(macdHistogram(candles, options));
  return Number.isFinite(value) ? value : null;
}

function normalizeEpochMs(raw) {
  const num = Number(raw || 0);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num < 1e12 ? num * 1000 : num;
}

function getLastCandleTime(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const last = candles[candles.length - 1];
  return normalizeEpochMs(
    last?.open_time ?? last?.start ?? last?.t ?? last?.timestamp
  );
}

function getLastCandleOpen(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const openPrice = Number(last?.open ?? last?.o);
  return Number.isFinite(openPrice) && openPrice > 0 ? openPrice : null;
}

function directionFromHistogram(histogram) {
  if (histogram === null) return 'neutral';
  if (histogram > 0) return 'bullish';
  if (histogram < 0) return 'negative';
  return 'neutral';
}

function evaluateMtfAlignment(candlesByTf = {}, previousSnapshot = null) {
  const values = {};
  const previousValues = {};
  const histogramValues = {};
  const previousHistogramValues = {};
  const candleTimes = {};
  const flippedBullish = [];
  const flipCandleTimes = {};
  const flipCandleOpens = {};

  for (const timeframe of REQUIRED_MTF_TFS) {
    const candles = Array.isArray(candlesByTf[timeframe])
      ? candlesByTf[timeframe]
      : [];

    // Evaluate active open candle strictly at its open price;
    // prior closed candle evaluated at its closed price.
    const currentHistogram = getHistogram(candles, {
      useOpenForLastCandle: true
    });
    const previousHistogram =
      candles.length >= 27
        ? getHistogram(candles.slice(0, -1), { useOpenForLastCandle: false })
        : null;

    const currentDirection = directionFromHistogram(currentHistogram);
    const previousDirection = directionFromHistogram(previousHistogram);
    const lastCandleTime = getLastCandleTime(candles);
    const lastCandleOpen = getLastCandleOpen(candles);

    values[timeframe] = currentDirection;
    previousValues[timeframe] = previousDirection;
    histogramValues[timeframe] = currentHistogram;
    previousHistogramValues[timeframe] = previousHistogram;
    candleTimes[timeframe] = lastCandleTime;

    // Strict flip: prior closed candle was negative (< 0) and current
    // candle evaluated at its open price is positive (> 0).
    const strictCandleFlip =
      previousHistogram !== null &&
      previousHistogram < 0 &&
      currentHistogram !== null &&
      currentHistogram > 0;

    // Only emit a flip once per timeframe candle open timestamp so
    // subsequent ticks on the same candle do not re-trigger or shift.
    const prevFlipTimeForTf = previousSnapshot?.flipCandleTimes?.[timeframe] || null;
    const isNewFlipCandle =
      strictCandleFlip &&
      lastCandleTime !== null &&
      lastCandleTime !== prevFlipTimeForTf;

    if (isNewFlipCandle) {
      flippedBullish.push(timeframe);
      flipCandleTimes[timeframe] = lastCandleTime;
      if (lastCandleOpen !== null) {
        flipCandleOpens[timeframe] = lastCandleOpen;
      }
    }
  }

  const bullishCount = REQUIRED_MTF_TFS.filter(
    (timeframe) => values[timeframe] === 'bullish'
  ).length;

  const negativeCount = REQUIRED_MTF_TFS.filter(
    (timeframe) => values[timeframe] === 'negative'
  ).length;

  const neutralCount = REQUIRED_MTF_TFS.filter(
    (timeframe) => values[timeframe] === 'neutral'
  ).length;

  const aligned = bullishCount === REQUIRED_MTF_TFS.length;

  let status = 'mixed';
  if (aligned) status = 'bullish';
  else if (negativeCount === REQUIRED_MTF_TFS.length) status = 'negative';
  else if (neutralCount === REQUIRED_MTF_TFS.length) status = 'neutral';

  // Pick the timeframe that flipped most recently (highest candleTime, then highest TF)
  const latestFlippedBullish =
    flippedBullish
      .map((timeframe) => ({
        timeframe,
        candleTime: flipCandleTimes[timeframe],
        openPrice: flipCandleOpens[timeframe] ?? null
      }))
      .sort((a, b) => {
        if ((b.candleTime || 0) !== (a.candleTime || 0)) {
          return (b.candleTime || 0) - (a.candleTime || 0);
        }
        return (TF_ORDER[b.timeframe] || 0) - (TF_ORDER[a.timeframe] || 0);
      })[0] || null;

  // Trigger alignmentFlip when all required TFs are bullish and at least one TF
  // just completed a strict negative-closed -> positive-open flip on this candle.
  const alignmentFlip = aligned && latestFlippedBullish !== null;

  return {
    status,
    values,
    previousValues,
    histogramValues,
    previousHistogramValues,
    candleTimes,
    aligned,
    alignmentFlip,
    flippedBullish,
    flipCandleTimes,
    flipCandleOpens,
    latestFlippedBullishTimeframe: latestFlippedBullish?.timeframe || null,
    latestFlipCandleTime: latestFlippedBullish?.candleTime || null,
    latestFlipOpenPrice: latestFlippedBullish?.openPrice ?? null,
    bullish: bullishCount,
    negative: negativeCount,
    neutral: neutralCount
  };
}

module.exports = {
  evaluateMtfAlignment,
  REQUIRED_MTF_TFS
};
```[cite: 5]

---

### `config.js`

```js
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

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BOUNDARY_SCAN_INTERVAL_MS = 15 * 60 * 1000;

const resolvedMinTvScore =
  typeof process.env.MIN_TV_SCORE !== 'undefined' &&
  String(process.env.MIN_TV_SCORE).trim() !== ''
    ? envFloat('MIN_TV_SCORE', 0.49)
    : envFloat('MIN_TV_RATING', 0.49);

module.exports = {
  BYBIT_REST_BASE: envString('BYBIT_REST_BASE', 'https://api.bybit.com'),
  BYBIT_WS_PUBLIC: envString(
    'BYBIT_WS_PUBLIC',
    'wss://stream.bybit.com/v5/public/linear'
  ),
  BYBIT_API_KEY: process.env.BYBIT_API_KEY || '',
  BYBIT_API_SECRET: process.env.BYBIT_API_SECRET || '',

  DATABASE_URL: process.env.DATABASE_URL || '',
  DB_SSL: envBool('DB_SSL', false),

  USE_WS: envBool('USE_WS', true),
  ENABLE_BOUNDARY_SCAN: envBool('ENABLE_BOUNDARY_SCAN', true),

  // Optional symbol allowlist. If empty, the bot fetches symbols once at startup.
  WATCH_SYMBOLS: parseList(process.env.WATCH_SYMBOLS, []),
  STARTUP_SCAN_MAX_SYMBOLS: envInt('STARTUP_SCAN_MAX_SYMBOLS', 50000),

  BYBIT_FETCH_RATE_LIMIT_MS: envInt('BYBIT_FETCH_RATE_LIMIT_MS', 250),
  BYBIT_REST_TIMEOUT_MS: envInt('BYBIT_REST_TIMEOUT_MS', 7000),
  SEED_KLINES_LIMIT: envInt('SEED_KLINES_LIMIT', 120),
  SEED_CONCURRENCY: envInt('SEED_CONCURRENCY', 1),

  WS_SUBSCRIBE_CHUNK: envInt('WS_SUBSCRIBE_CHUNK', 30),
  WS_RECONNECT_DELAY_MS: envInt('WS_RECONNECT_DELAY_MS', 800),
  WS_RECONNECT_BACKOFF_FACTOR: envFloat('WS_RECONNECT_BACKOFF_FACTOR', 2),
  WS_RECONNECT_MAX_MS: envInt('WS_RECONNECT_MAX_MS', 24000),
  WS_MAX_RECONNECT_ATTEMPTS: envInt('WS_MAX_RECONNECT_ATTEMPTS', 8),
  WS_INITIAL_SCAN_TIMEOUT: envInt('WS_INITIAL_SCAN_TIMEOUT', 8000),

  SYMBOL_FILTER: envString('SYMBOL_FILTER', '^[A-Z0-9]+USDT(\\.P)?$'),
  MTF_TFS: parseList(process.env.MTF_TFS, ['5', '15', '60', '240']),

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

  MIN_TV_RATING: resolvedMinTvScore,
  MIN_TV_SCORE: resolvedMinTvScore,
  MIN_CUSTOM_SCORE: envFloat('MIN_CUSTOM_SCORE', 65),
  MAX_CONSECUTIVE_ROOT_SIGNALS_1D: envInt(
    'MAX_CONSECUTIVE_ROOT_SIGNALS_1D',
    2
  ),

  // TV rating endpoint and cache
  TRADINGVIEW_RATING_ENABLED: envBool('TRADINGVIEW_RATING_ENABLED', true),
  TRADINGVIEW_RATING_ENDPOINT: envString('TRADINGVIEW_RATING_ENDPOINT', ''),
  TRADINGVIEW_RATING_INTERVAL: envString('TRADINGVIEW_RATING_INTERVAL', '1D'),
  TRADINGVIEW_RATING_TIMEOUT_MS: envInt('TRADINGVIEW_RATING_TIMEOUT_MS', 5000),
  TRADINGVIEW_RATING_CACHE_MS: envInt('TRADINGVIEW_RATING_CACHE_MS', 60000),

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  TELEGRAM_SEND_DELAY_MS: envInt('TELEGRAM_SEND_DELAY_MS', 250),
  TELEGRAM_PUSH_FULL: envBool('TELEGRAM_PUSH_FULL', false),
  TELEGRAM_DEDUPE_TTL_MS: envInt('TELEGRAM_DEDUPE_TTL_MS', 60 * 1000),

  ALIGNMENT_CONFIRMATION_ALERT: envBool(
    'ALIGNMENT_CONFIRMATION_ALERT',
    true
  ),

  PORT: envInt('PORT', 3000),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  ENABLE_KEEPALIVE_PING: envBool('ENABLE_KEEPALIVE_PING', true),
  KEEPALIVE_URL: process.env.KEEPALIVE_URL || '',
  KEEPALIVE_INTERVAL_MS: envInt(
    'KEEPALIVE_INTERVAL_MS',
    5 * 60 * 1000
  ),

  CLOSE_LEAST_PROFITABLE_ENABLED: envBool(
    'CLOSE_LEAST_PROFITABLE_ENABLED',
    false
  ),
  CLOSE_LEAST_PROFITABLE_MINS_BEFORE_BOUNDARY: envInt(
    'CLOSE_LEAST_PROFITABLE_MINS_BEFORE_BOUNDARY',
    5
  ),

  BYBIT_REST_BASES: parseList(
    process.env.BYBIT_REST_BASES,
    ['https://api.bybit.com']
  ),
  BYBIT_ORDER_BASE: process.env.BYBIT_ORDER_BASE || '',
  MAINNET: envBool('MAINNET', true),
  BYBIT_USE_TESTNET: envBool('BYBIT_USE_TESTNET', false),
  ENABLE_OPEN_TRADES: envBool('ENABLE_OPEN_TRADES', false),

  BOUNDARY_SCAN_INTERVAL_MS: envInt(
    'BOUNDARY_SCAN_INTERVAL_MS',
    DEFAULT_BOUNDARY_SCAN_INTERVAL_MS
  ),
  DAILY_CLEANUP_INTERVAL_MS: envInt(
    'DAILY_CLEANUP_INTERVAL_MS',
    DAY_MS
  ),
  SIGNALS_RETENTION_MS: envInt('SIGNALS_RETENTION_MS', 30 * DAY_MS),
  MTF_EVENTS_RETENTION_MS: envInt('MTF_EVENTS_RETENTION_MS', 7 * DAY_MS),
  SCAN_RUNS_RETENTION_MS: envInt('SCAN_RUNS_RETENTION_MS', 30 * DAY_MS)
};
```[cite: 7]
