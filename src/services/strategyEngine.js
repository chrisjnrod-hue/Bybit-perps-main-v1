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
  countOpenTrades,
  hasRecentSignal
} = require('../db');
const { filterUsdtPerpetualSymbols } = require('./symbolScanner');
const {
  evaluateSignal,
  detectDailyRootSignal
} = require('./signalManager');
const { shouldOpenTrade, buildTradePlan } = require('./tradeManager');
const { ensureTradeFromSignal, updateTradeFromMarket } = require('./openTradeTracker');
const { sendTelegramMessage } = require('./telegram');
const {
  formatSummaryTelegramChunks,
  formatMtfAlignmentAlert,
  formatRecommendationTelegram
} = require('./telegramFormatter');
const { buildMarketData } = require('./marketData');
const { setupKeepAlive } = require('./keepalive');

const pLimit = require('p-limit');

let wsBootstrapped = false;
let lastDailyCleanupAt = 0;
let boundaryScanRunning = false;

const DEFAULT_TIMEFRAMES = ['5', '15', '60', '240', 'D'];
const MTF_TIMEFRAMES = ['5', '15', '60', '240'];
const DEFAULT_BOUNDARY_SCAN_MS = 15 * 60 * 1000;

const sentAlignmentAlerts = new Set();
const sentRecommendations = new Set();
const marketDataCache = new Map();
const MARKET_DATA_CACHE_TTL_MS = 15 * 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBoundaryScanIntervalMs() {
  const raw = Number(config.BOUNDARY_SCAN_INTERVAL_MS ?? DEFAULT_BOUNDARY_SCAN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BOUNDARY_SCAN_MS;
}

function getStartupTimeframes() {
  const configured = process.env.STARTUP_SCAN_TIMEFRAMES;

  if (typeof configured !== 'string' || configured.trim() === '') {
    return DEFAULT_TIMEFRAMES;
  }

  const requested = configured
    .split(',')
    .map((tf) => tf.trim())
    .filter(Boolean);

  return [...new Set([...requested, ...DEFAULT_TIMEFRAMES])];
}

function getStartupScanLimit() {
  const raw = process.env.STARTUP_SCAN_MAX_SYMBOLS;
  if (typeof raw === 'undefined' || raw === '') return 0;

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function getStartupScanDelayMs() {
  const value = Number(
    config.STARTUP_SCAN_DELAY_MS ?? process.env.STARTUP_SCAN_DELAY_MS ?? 1000
  );

  return Number.isFinite(value) && value >= 0 ? value : 1000;
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
    signal.mtfStatus || 'neutral',
    signal.reason || 'n/a'
  ].join(':');
}

function buildScanSummaryKey(signals = []) {
  return (signals || [])
    .map((s) => [
      String(s?.symbol || '').toUpperCase(),
      Number(s?.dailyCandleTime || 0),
      String(s?.reason || 'n/a')
    ].join(':'))
    .sort()
    .join('|');
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
  if (signal?.decision !== 'accept' || signal?.mtfAligned !== true) {
    return false;
  }

  const key = dailySignalKey(signal);
  if (sentAlignmentAlerts.has(key)) return false;

  try {
    const result = await sendTelegramBlock(
      formatMtfAlignmentAlert(alertData(signal, marketData)),
      buildSignalDedupeKey(signal, 'mtf-alignment')
    );

    if (result) {
      sentAlignmentAlerts.add(key);
    }

    return Boolean(result);
  } catch (err) {
    console.error(`MTF alignment alert failed for ${signal.symbol}:`, err.message);
    return false;
  }
}

async function maybeSendRecommendation(signal, marketData) {
  if (signal?.decision !== 'accept') return false;

  const key = dailySignalKey(signal);
  if (sentRecommendations.has(key)) return false;

  try {
    const openCount = await countOpenTrades();
    if (openCount >= Number(config.MAX_OPEN_TRADES || 3)) return false;

    const conditions = {
      volume24hUsd: Number(marketData.volume24hUsd || 0),
      spreadPct: Number(marketData.spreadPct || 0),
      topOfBookDepthUsd: Number(marketData.topOfBookDepthUsd || 0)
    };

    const tradeCheck = shouldOpenTrade(signal, conditions);
    if (!tradeCheck.open) return false;

    const plan = buildTradePlan(signal, conditions);
    const savedTrade = await ensureTradeFromSignal(signal, plan);

    if (!savedTrade) return false;

    const result = await sendTelegramBlock(
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

    if (result) {
      sentRecommendations.add(key);
    }

    return Boolean(result);
  } catch (err) {
    console.error(`Trade recommendation failed for ${signal.symbol}:`, err.message);
    return false;
  }
}

async function evaluateAndDispatchSymbol(symbol, options = {}) {
  const { sendAlert = true, sendRecommendation = true } = options;

  const candlesByTf = await getStoredCandles(symbol);
  const marketData = await getMarketDataCached(symbol);
  const signal = await evaluateSignal(symbol, candlesByTf, marketData);

  if (!signal) return null;

  if (sendAlert && signal.decision === 'accept' && signal.mtfAligned) {
    await maybeSendAlignmentAlert(signal, marketData);
  }

  if (sendRecommendation && signal.decision === 'accept') {
    await maybeSendRecommendation(signal, marketData);
  }

  return signal;
}

async function handleWebSocketKline(msg) {
  const topicInfo = getSymbolAndTimeframeFromTopic(msg?.topic);
  if (!topicInfo) return;

  const { symbol, timeframe } = topicInfo;
  if (!DEFAULT_TIMEFRAMES.includes(timeframe)) return;

  const candle = normalizeWsCandle(msg);
  if (!candle || !symbol) return;

  try {
    await saveKline(symbol, timeframe, candle);

    await evaluateAndDispatchSymbol(symbol, {
      sendAlert: true,
      sendRecommendation: true
    });

    if (timeframe === 'D') {
      await performDailyCleanup();
      await syncOpenTradesFromMarket();
    }
  } catch (err) {
    console.error(`WebSocket signal evaluation failed for ${symbol} ${timeframe}:`, err);
  }
}

async function scanSymbolCandidate(symbol) {
  try {
    const dailyCandles = await fetchKlines(symbol, 'D', 200);
    if (!dailyCandles || dailyCandles.length < 26) return null;

    const rootCandidate = detectDailyRootSignal(dailyCandles, { symbol, lastPrice: 0 });
    if (!rootCandidate) return null;

    const byTf = {
      D: dailyCandles,
      '5': await fetchKlines(symbol, '5', 200),
      '15': await fetchKlines(symbol, '15', 200),
      '60': await fetchKlines(symbol, '60', 200),
      '240': await fetchKlines(symbol, '240', 200)
    };

    const marketData = await getMarketDataCached(symbol);
    const signal = await evaluateSignal(symbol, byTf, marketData);

    if (!signal) return null;

    return {
      symbol,
      dailyCandleTime: signal.dailyCandleTime,
      reason: signal.reason,
      mtfStatus: signal.mtfStatus,
      signal
    };
  } catch (err) {
    console.error(`Initial scan failed for symbol ${symbol}:`, err);
    return null;
  }
}

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

  if (config.USE_WS) {
    bybitWs.on('kline', handleWebSocketKline);
    bybitWs.connect();

    if (!wsBootstrapped) {
      bybitWs.subscribe(symbols, DEFAULT_TIMEFRAMES);
      wsBootstrapped = true;
    }
  }

  const startupScanLimit = getStartupScanLimit();
  const startupSymbols =
    startupScanLimit > 0 ? symbols.slice(0, startupScanLimit) : symbols;

  const limited = pLimit(Number(config.STARTUP_SCAN_CONCURRENCY || 4));

  const startupResults = await Promise.all(
    startupSymbols.map((symbol) => limited(() => scanSymbolCandidate(symbol)))
  );

  const startupSignals = [];
  const startupAlerts = [];
  const startupRecommendations = [];

  for (const item of startupResults) {
    if (!item || !item.signal) continue;

    const { signal } = item;

    startupSignals.push({
      symbol: signal.symbol,
      dailyCandleTime: signal.dailyCandleTime,
      reason: signal.reason
    });

    if (signal.decision === 'accept' && signal.mtfAligned) {
      startupAlerts.push({ signal, marketData: await getMarketDataCached(signal.symbol) });
    }

    if (signal.decision === 'accept') {
      const openCount = await countOpenTrades();

      if (openCount < Number(config.MAX_OPEN_TRADES || 3)) {
        const marketData = await getMarketDataCached(signal.symbol);
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
  }

  const startupSummaryChunks = formatSummaryTelegramChunks(startupSignals);

  for (let i = 0; i < startupSummaryChunks.length; i++) {
    const dedupeKey = `summary:startup:${buildScanSummaryKey(startupSignals)}:${i}`;
    await sendTelegramBlock(startupSummaryChunks[i], dedupeKey);
  }

  for (const item of startupAlerts) {
    await maybeSendAlignmentAlert(item.signal, item.marketData);
    if (config.TELEGRAM_SEND_DELAY_MS > 0) {
      await delay(config.TELEGRAM_SEND_DELAY_MS);
    }
  }

  for (const item of startupRecommendations) {
    await sendTelegramBlock(
      item.text,
      buildSignalDedupeKey(item.signal, 'recommendation')
    );
    if (config.TELEGRAM_SEND_DELAY_MS > 0) {
      await delay(config.TELEGRAM_SEND_DELAY_MS);
    }
  }

  async function boundaryScanTick() {
    if (boundaryScanRunning) return;
    boundaryScanRunning = true;

    try {
      const activeSymbols = await seedSymbols();

      const newRootSignals = [];
      const seenRootKeys = new Set();

      const limitedBoundary = pLimit(Number(config.BOUNDARY_SCAN_CONCURRENCY || 4));

      const boundaryResults = await Promise.all(
        activeSymbols.map((symbol) =>
          limitedBoundary(async () => {
            const dailyCandles = await fetchKlines(symbol, 'D', 200);
            if (!dailyCandles || dailyCandles.length < 26) return null;

            const root = detectDailyRootSignal(dailyCandles, { symbol });
            if (!root) return null;

            const key = `${symbol}:${root.dailyCandleTime}`;
            if (seenRootKeys.has(key)) return null;
            seenRootKeys.add(key);

            const exists = await hasRecentSignal(symbol, root.dailyCandleTime, root.reason, 30);
            if (exists) return null;

            const byTf = {
              D: dailyCandles,
              '5': await fetchKlines(symbol, '5', 200),
              '15': await fetchKlines(symbol, '15', 200),
              '60': await fetchKlines(symbol, '60', 200),
              '240': await fetchKlines(symbol, '240', 200)
            };

            const marketData = await getMarketDataCached(symbol);
            const signal = await evaluateSignal(symbol, byTf, marketData);

            if (!signal) return null;

            return {
              signal,
              marketData,
              root
            };
          })
        )
      );

      for (const item of boundaryResults) {
        if (!item || !item.signal) continue;

        const { signal, marketData } = item;

        newRootSignals.push({
          symbol: signal.symbol,
          dailyCandleTime: signal.dailyCandleTime,
          reason: signal.reason
        });

        if (signal.decision === 'accept' && signal.mtfAligned) {
          await maybeSendAlignmentAlert(signal, marketData);
        }

        if (signal.decision === 'accept') {
          await maybeSendRecommendation(signal, marketData);
        }
      }

      if (newRootSignals.length) {
        const summaryKey = `summary:boundary:${buildScanSummaryKey(newRootSignals)}`;
        const chunks = formatSummaryTelegramChunks(newRootSignals);

        for (let i = 0; i < chunks.length; i++) {
          await sendTelegramBlock(chunks[i], `${summaryKey}:${i}`);
        }
      }
    } catch (err) {
      console.error('Boundary scan failed:', err);
    } finally {
      boundaryScanRunning = false;
    }
  }

  if (config.ENABLE_BOUNDARY_SCAN) {
    const boundaryScanMs = getBoundaryScanIntervalMs();

    // run immediately once, then on exact interval
    boundaryScanTick().catch((err) => {
      console.error('Immediate boundary scan failed:', err);
    });

    setInterval(() => {
      boundaryScanTick().catch((err) => {
        console.error('Scheduled boundary scan failed:', err);
      });
    }, boundaryScanMs);
  }
}

module.exports = {
  bootstrapStrategy,
  performDailyCleanup,
  evaluateAndDispatchSymbol,
  syncOpenTradesFromMarket
};
