const config = require('../config');
const { fetchAllSymbols, fetchKlines } = require('./bybitRest');
const bybitWs = require('./bybitWs');
const {
  upsertSymbol,
  saveKlines,
  getLatestCandles,
  listOpenTrades,
  saveKline,
  query,
  countOpenTrades
} = require('../db');
const { filterUsdtPerpetualSymbols } = require('./symbolScanner');
const { evaluateSignal } = require('./signalManager');
const { shouldOpenTrade, buildTradePlan } = require('./tradeManager');
const { ensureTradeFromSignal, updateTradeFromMarket } = require('./openTradeTracker');
const { sendTelegramMessage } = require('./telegram');
const {
  formatSummaryTelegram,
  formatMtfAlignmentAlert,
  formatRecommendationTelegram
} = require('./telegramFormatter');
const { buildMarketData } = require('./marketData');
const { setupKeepAlive } = require('./keepalive');

let wsBootstrapped = false;
let lastDailyCleanupAt = 0;
let boundaryScanRunning = false;

const DEFAULT_TIMEFRAMES = ['5', '15', '60', '240', 'D'];
const MTF_TIMEFRAMES = ['5', '15', '60', '240'];

// Prevent concurrent WebSocket updates from sending duplicate alerts for a symbol.
const alertInFlight = new Set();
const recommendationInFlight = new Set();
const sentAlignmentAlerts = new Set();
const sentRecommendations = new Set();

// Cache market data to avoid repeatedly fetching order books/tickers on every
// open-candle WebSocket update.
const marketDataCache = new Map();
const MARKET_DATA_CACHE_TTL_MS = 15 * 1000;

function getStartupTimeframes() {
  const configured = process.env.STARTUP_SCAN_TIMEFRAMES;

  if (typeof configured !== 'string' || configured.trim() === '') {
    return DEFAULT_TIMEFRAMES;
  }

  const requested = configured
    .split(',')
    .map((tf) => tf.trim())
    .filter(Boolean);

  // The root signal needs D; MTF alignment needs all four intraday timeframes.
  return [...new Set([...requested, ...DEFAULT_TIMEFRAMES])];
}

function getStartupScanLimit() {
  const value = Number(
    config.STARTUP_SCAN_MAX_SYMBOLS ??
    process.env.STARTUP_SCAN_MAX_SYMBOLS ??
    20
  );

  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function getStartupScanDelayMs() {
  const value = Number(
    config.STARTUP_SCAN_DELAY_MS ??
    process.env.STARTUP_SCAN_DELAY_MS ??
    1000
  );

  return Number.isFinite(value) && value >= 0 ? value : 1000;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dailySignalKey(signal) {
  const candleTime = Number(signal?.dailyCandleTime || 0);
  return `${signal?.symbol || 'unknown'}:${candleTime || 'current-daily-candle'}`;
}

function buildSignalDedupeKey(signal, type) {
  return [
    type,
    signal.symbol,
    dailySignalKey(signal),
    signal.dailyHistogramDirection || 'neutral'
  ].join(':');
}

async function sendTelegramBlock(text, dedupeKey) {
  if (!text) return null;

  return sendTelegramMessage(text, {
    dedupeKey,
    ttlMs: config.TELEGRAM_DEDUPE_TTL_MS || 60 * 1000
  });
}

async function getMarketDataCached(symbol) {
  const now = Date.now();
  const cached = marketDataCache.get(symbol);

  if (cached && now - cached.cachedAt < MARKET_DATA_CACHE_TTL_MS) {
    return cached.data;
  }

  const data = await buildMarketData(symbol);
  marketDataCache.set(symbol, { cachedAt: now, data });
  return data;
}

function alertData(signal, marketData = {}) {
  return {
    symbol: signal.symbol,
    time: new Date().toISOString(),
    decision: signal.decision,
    reason: signal.reason,
    customScore: signal.customScore,
    tvScore: signal.tvScore,
    mtfStatus: signal.mtfStatus,
    mtfValues: signal.mtfValues,
    price: Number(signal.price || marketData.lastPrice || 0),
    volume24h: Number(marketData.volume24hUsd || 0),
    spreadPct: Number(marketData.spreadPct || 0),
    liquidity: signal.liquidity?.valid
      ? 'valid'
      : signal.liquidity?.reason || 'unknown',
    trailingStop: 'higher_lows or close below 14MA',
    takeProfit: '3%',
    action: signal.decision === 'accept' ? 'open' : 'monitor'
  };
}

async function seedSymbols() {
  const symbols = await fetchAllSymbols();
  const filtered = filterUsdtPerpetualSymbols(symbols);

  for (const symbol of filtered) {
    const base = symbol.replace(/USDT(\.P)?$/i, '');
    await upsertSymbol(symbol, base, 'USDT', 'active');
  }

  return filtered;
}

async function fetchCandlesForSymbol(symbol, timeframes = DEFAULT_TIMEFRAMES) {
  const byTf = {};

  for (const tf of timeframes) {
    const candles = await fetchKlines(symbol, tf, 200);
    await saveKlines(symbol, tf, candles);
    byTf[tf] = candles;
  }

  return byTf;
}

async function getStoredCandles(symbol) {
  const byTf = {};

  for (const tf of DEFAULT_TIMEFRAMES) {
    byTf[tf] = await getLatestCandles(symbol, tf, 200);
  }

  return byTf;
}

function normalizeWsCandle(payload) {
  if (!payload) return null;

  const kline = payload?.data?.[0] || payload?.data || payload;
  if (!kline) return null;

  return {
    open_time: Number(kline.start || kline.t || kline.open_time || 0),
    open: Number(kline.open || kline.o || 0),
    high: Number(kline.high || kline.h || 0),
    low: Number(kline.low || kline.l || 0),
    close: Number(kline.close || kline.c || 0),
    volume: Number(kline.volume || kline.v || 0)
  };
}

function getSymbolAndTimeframeFromTopic(topic) {
  const parts = String(topic || '').split('.');
  if (parts.length < 3 || parts[0] !== 'kline') return null;

  return {
    timeframe: parts[1],
    symbol: parts.slice(2).join('.')
  };
}

async function performDailyCleanup() {
  try {
    const now = Date.now();
    const interval = config.DAILY_CLEANUP_INTERVAL_MS || 24 * 60 * 60 * 1000;

    if (now - lastDailyCleanupAt < interval) return;

    lastDailyCleanupAt = now;

    const cutoff = now - 24 * 60 * 60 * 1000;
    await query(
      `DELETE FROM klines WHERE open_time < $1 AND timeframe != 'D'`,
      [cutoff]
    );

    console.log('Daily cache cleanup completed successfully.');
  } catch (err) {
    console.error('Daily cleanup failed:', err);
  }
}

async function syncOpenTradesFromMarket() {
  const openTrades = await listOpenTrades();

  for (const trade of openTrades) {
    const candles = await getLatestCandles(trade.symbol, 'D', 200);
    const marketData = await getMarketDataCached(trade.symbol);
    const currentPrice = Number(marketData.lastPrice || 0);

    if (currentPrice > 0) {
      await updateTradeFromMarket(trade.symbol, currentPrice, candles || []);
    }
  }
}

async function maybeSendAlignmentAlert(signal, marketData) {
  // The formatter is an alignment alert; do not send it for an unaligned
  // monitoring candidate.
  if (!signal?.mtfAlignedWithDaily && !signal?.mtfAligned) return false;

  const key = dailySignalKey(signal);
  if (sentAlignmentAlerts.has(key) || alertInFlight.has(key)) return false;

  alertInFlight.add(key);

  try {
    const response = await sendTelegramBlock(
      formatMtfAlignmentAlert(alertData(signal, marketData)),
      buildSignalDedupeKey(signal, 'mtf-alignment')
    );

    // A null response can mean Telegram is not configured or the sender
    // suppressed a duplicate. Avoid retrying every WebSocket update.
    sentAlignmentAlerts.add(key);
    return Boolean(response);
  } catch (err) {
    console.error(`MTF alignment alert failed for ${signal.symbol}:`, err.message);
    return false;
  } finally {
    alertInFlight.delete(key);
  }
}

async function maybeSendRecommendation(signal, marketData) {
  if (signal?.decision !== 'accept') return false;

  const key = dailySignalKey(signal);
  if (sentRecommendations.has(key) || recommendationInFlight.has(key)) {
    return false;
  }

  recommendationInFlight.add(key);

  try {
    const openCount = await countOpenTrades();
    if (openCount >= Number(config.MAX_OPEN_TRADES || 3)) return false;

    const marketConditions = {
      volume24hUsd: Number(marketData.volume24hUsd || 0),
      spreadPct: Number(marketData.spreadPct || 0),
      topOfBookDepthUsd: Number(marketData.topOfBookDepthUsd || 0)
    };

    const tradeCheck = shouldOpenTrade(signal, marketConditions);
    if (!tradeCheck.open) return false;

    const plan = buildTradePlan(signal, marketConditions);
    const savedTrade = await ensureTradeFromSignal(signal, plan);
    if (!savedTrade) return false;

    const response = await sendTelegramBlock(
      formatRecommendationTelegram({
        symbol: signal.symbol,
        action: 'open',
        customScore: signal.customScore,
        tvScore: signal.tvScore,
        mtfStatus: signal.mtfStatus,
        mtfValues: signal.mtfValues,
        liquidity: signal.liquidity?.valid ? 'valid' : 'invalid',
        reason: signal.reason,
        plan
      }),
      buildSignalDedupeKey(signal, 'recommendation')
    );

    sentRecommendations.add(key);
    return Boolean(response);
  } catch (err) {
    console.error(`Trade recommendation failed for ${signal.symbol}:`, err.message);
    return false;
  } finally {
    recommendationInFlight.delete(key);
  }
}

/**
 * Evaluate one symbol using its current stored candles.
 * WebSocket updates call this as soon as any of the four MTF candles or the
 * daily candle updates, so alignment does not need to wait for a boundary scan.
 */
async function evaluateAndDispatchSymbol(symbol, options = {}) {
  const { sendAlert = true, sendRecommendation = true } = options;
  const candlesByTf = await getStoredCandles(symbol);

  // First identify the daily root candidate and calculate its MTF state.
  let signal = await evaluateSignal(symbol, candlesByTf, {});

  if (!signal) return null;

  // Only fetch market data once a daily candidate exists.
  const marketData = await getMarketDataCached(symbol);

  // Re-evaluate with current ticker/liquidity data for the final scores/fields.
  signal = await evaluateSignal(symbol, candlesByTf, marketData);
  if (!signal) return null;

  if (sendAlert) {
    await maybeSendAlignmentAlert(signal, marketData);
  }

  if (sendRecommendation) {
    await maybeSendRecommendation(signal, marketData);
  }

  return signal;
}

async function evaluateAndSendBoundary(symbol) {
  return evaluateAndDispatchSymbol(symbol, {
    sendAlert: true,
    sendRecommendation: true
  });
}

async function handleWebSocketKline(msg) {
  const topicInfo = getSymbolAndTimeframeFromTopic(msg?.topic);
  if (!topicInfo) return;

  const { symbol, timeframe } = topicInfo;
  if (!DEFAULT_TIMEFRAMES.includes(timeframe)) return;

  const candle = normalizeWsCandle(msg);
  if (!candle || !symbol) return;

  try {
    // Bybit sends updates while the candle is still open. Save and evaluate
    // every update; do not wait for a closed-candle confirmation.
    await saveKline(symbol, timeframe, candle);

    // Every MTF update can be the final timeframe to align. A daily update can
    // also create the root signal while MTF directions are already aligned.
    await evaluateAndDispatchSymbol(symbol, {
      sendAlert: true,
      sendRecommendation: true
    });

    if (timeframe === 'D') {
      await performDailyCleanup();
      await syncOpenTradesFromMarket();
    }
  } catch (err) {
    console.error(
      `WebSocket signal evaluation failed for ${symbol} ${timeframe}:`,
      err
    );
  }
}

async function sendStartupNotifications(signals, alertBlocks, recommendationBlocks) {
  // Preserve the requested startup order: summary, MTF alerts, recommendations.
  await sendTelegramBlock(
    formatSummaryTelegram(signals),
    'summary:startup'
  );

  for (const item of alertBlocks) {
    await maybeSendAlignmentAlert(item.signal, item.marketData);

    if (config.TELEGRAM_SEND_DELAY_MS > 0) {
      await delay(config.TELEGRAM_SEND_DELAY_MS);
    }
  }

  for (const item of recommendationBlocks) {
    await sendTelegramBlock(
      item.text,
      buildSignalDedupeKey(item.signal, 'recommendation')
    );

    if (config.TELEGRAM_SEND_DELAY_MS > 0) {
      await delay(config.TELEGRAM_SEND_DELAY_MS);
    }
  }
}

async function runBoundaryScan() {
  if (boundaryScanRunning) return;
  boundaryScanRunning = true;

  try {
    const symbols = await seedSymbols();
    const newDailySignals = [];

    for (const symbol of symbols) {
      // Refresh candles for REST-only deployments. With WebSockets enabled,
      // live updates handle intrabar alerts independently of this interval.
      const candlesByTf = await fetchCandlesForSymbol(symbol, DEFAULT_TIMEFRAMES);
      let signal = await evaluateSignal(symbol, candlesByTf, {});

      if (!signal) {
        await delay(50);
        continue;
      }

      const marketData = await getMarketDataCached(symbol);
      signal = await evaluateSignal(symbol, candlesByTf, marketData);

      if (signal) {
        const key = dailySignalKey(signal);
        if (!runBoundaryScan.seenDailySignals.has(key)) {
          runBoundaryScan.seenDailySignals.add(key);
          newDailySignals.push(signal);
        }

        await maybeSendAlignmentAlert(signal, marketData);
        await maybeSendRecommendation(signal, marketData);
      }

      await delay(50);
    }

    if (newDailySignals.length) {
      const key = newDailySignals
        .map(dailySignalKey)
        .sort()
        .join(',');

      await sendTelegramBlock(
        formatSummaryTelegram(newDailySignals),
        `summary:boundary:${key}`
      );
    }

    await syncOpenTradesFromMarket();
  } catch (err) {
    console.error('Periodic boundary scan failed:', err);
  } finally {
    boundaryScanRunning = false;
  }
}

runBoundaryScan.seenDailySignals = new Set();

async function bootstrapStrategy() {
  console.log('Bootstrapping strategy');
  setupKeepAlive();

  const symbols = await seedSymbols();

  if (!symbols.length) {
    console.log('No symbols loaded');
    return;
  }

  if (config.DAILY_CLEANUP_INTERVAL_MS) {
    setInterval(performDailyCleanup, config.DAILY_CLEANUP_INTERVAL_MS);
  }

  // Register the listener before subscribing so the first live candle updates
  // are not missed. Intrabar alerting requires USE_WS=true.
  if (config.USE_WS) {
    bybitWs.on('kline', handleWebSocketKline);
    bybitWs.connect();

    if (!wsBootstrapped) {
      bybitWs.subscribe(symbols, DEFAULT_TIMEFRAMES);
      wsBootstrapped = true;
    }
  } else {
    console.warn(
      '[strategyEngine] USE_WS is disabled; intrabar alerts will only be evaluated during startup/boundary scans.'
    );
  }

  const maxStartupSymbols = getStartupScanLimit();
  const startupSymbols =
    maxStartupSymbols > 0 ? symbols.slice(0, maxStartupSymbols) : symbols;
  const startupTimeframes = getStartupTimeframes();
  const startupDelayMs = getStartupScanDelayMs();

  console.log(
    `Starting startup scan across ${startupSymbols.length} of ${symbols.length} symbols; ` +
    `timeframes=${startupTimeframes.join(',')}; delay=${startupDelayMs}ms`
  );

  const startupSignals = [];
  const startupAlerts = [];
  const startupRecommendations = [];

  for (const symbol of startupSymbols) {
    let stage = 'starting';

    try {
      if (startupDelayMs > 0) {
        await delay(startupDelayMs);
      }

      stage = 'fetching candles';
      const candlesByTf = await fetchCandlesForSymbol(symbol, startupTimeframes);

      stage = 'evaluating daily root and MTF';
      let signal = await evaluateSignal(symbol, candlesByTf, {});

      if (!signal) continue;

      startupSignals.push(signal);
      runBoundaryScan.seenDailySignals.add(dailySignalKey(signal));

      stage = 'fetching candidate market data';
      const marketData = await getMarketDataCached(symbol);

      // Re-evaluate with market data for current price/liquidity/score fields.
      signal = await evaluateSignal(symbol, candlesByTf, marketData);
      if (!signal) continue;

      if (signal.mtfAlignedWithDaily || signal.mtfAligned) {
        startupAlerts.push({ signal, marketData });
      }

      if (signal.decision === 'accept') {
        const openCount = await countOpenTrades();

        if (openCount < Number(config.MAX_OPEN_TRADES || 3)) {
          const conditions = {
            volume24hUsd: Number(marketData.volume24hUsd || 0),
            spreadPct: Number(marketData.spreadPct || 0),
            topOfBookDepthUsd: Number(marketData.topOfBookDepthUsd || 0)
          };

          const tradeCheck = shouldOpenTrade(signal, conditions);
          if (tradeCheck.open) {
            const plan = buildTradePlan(signal, conditions);
            const savedTrade = await ensureTradeFromSignal(signal, plan);

            if (savedTrade) {
              startupRecommendations.push({
                signal,
                text: formatRecommendationTelegram({
                  symbol: signal.symbol,
                  action: 'open',
                  customScore: signal.customScore,
                  tvScore: signal.tvScore,
                  mtfStatus: signal.mtfStatus,
                  mtfValues: signal.mtfValues,
                  liquidity: signal.liquidity?.valid ? 'valid' : 'invalid',
                  reason: signal.reason,
                  plan
                })
              });
            }
          }
        }
      }
    } catch (err) {
      console.error(`Initial scan failed for ${symbol} during ${stage}:`, {
        message: err?.message,
        status: err?.response?.status,
        statusText: err?.response?.statusText,
        retCode: err?.response?.data?.retCode ?? err?.response?.data?.ret_code ?? null,
        retMsg: err?.response?.data?.retMsg ?? err?.response?.data?.ret_msg ?? null,
        response: err?.response?.data ?? null,
        stack: err?.stack
      });
    }
  }

  // Mark startup alerts as sent when dispatching, so the first WebSocket event
  // does not duplicate an alert already included in the startup message batch.
  for (const item of startupAlerts) {
    sentAlignmentAlerts.add(dailySignalKey(item.signal));
  }

  await sendStartupNotifications(
    startupSignals,
    startupAlerts,
    startupRecommendations
  );

  if (config.ENABLE_BOUNDARY_SCAN) {
    setInterval(
      runBoundaryScan,
      config.BOUNDARY_SCAN_INTERVAL_MS || 15000
    );
  }
}

module.exports = {
  bootstrapStrategy,
  performDailyCleanup,
  evaluateAndSendBoundary,
  evaluateAndDispatchSymbol,
  syncOpenTradesFromMarket
};
