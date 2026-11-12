// src/services/strategyEngine.js
const config = require('../config');
const { fetchAllSymbols, fetchKlines } = require('./bybitRest');
const bybitWs = require('./bybitWs');
const {
  upsertSymbol,
  getLatestCandles,
  listOpenTrades,
  saveKline,
  saveKlines,
  countOpenTrades,
  recordSignal,
  notificationWasSent,
  markNotificationSent,
  purgeStaleCache
} = require('../db');
const { filterUsdtPerpetualSymbols } = require('./symbolScanner');
const {
  evaluateSignal,
  detectDailyRootSignal
} = require('./signalManager');
const { macdHistogram } = require('./macd');
const {
  shouldOpenTrade,
  rankTradeCandidates,
  buildTradePlan
} = require('./tradeManager');
const {
  ensureTradeFromSignal,
  updateTradeFromMarket
} = require('./openTradeTracker');
const { sendTelegramMessage } = require('./telegram');
const {
  formatSummaryTelegramChunks,
  formatMtfAlignmentAlert,
  formatRecommendationTelegram
} = require('./telegramFormatter');
const { buildMarketData } = require('./marketData');
const { setupKeepAlive } = require('./keepalive');

const TIMEFRAMES = ['5', '15', '60', '240', 'D'];
const MTF_TIMEFRAMES = ['5', '15', '60', '240'];

const ROOT_SUMMARY_PREFIX = 'root-summary';
const ALIGNMENT_PREFIX = 'mtf-alignment';
const RECOMMENDATION_PREFIX = 'recommendation';

const MARKET_DATA_CACHE_TTL_MS = 1000;
const EVALUATION_DEBOUNCE_MS = 300;
const TRADE_RANKING_WINDOW_MS = 1000;

let bootstrapped = false;
let startupReady = false;
let seedingHistory = false;
let batchScanRunning = false;
let boundaryScanRunning = false;
let cleanupRunning = false;
let lastCleanupAt = 0;
let tradeQueueTimer = null;

const symbols = new Set();
const marketDataCache = new Map();
const pendingEvaluations = new Map();
const deferredSymbols = new Set();
const bufferedKlines = new Map();
const tradeCandidates = new Map();

// A root remains monitored for the rest of its daily candle. This state is
// in memory; it is reset when a new daily candle begins or the process restarts.
const monitoredRoots = new Map();
const evaluatingSymbols = new Set();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dailySignalKey(signal) {
  return `${signal.symbol}:${Number(signal.dailyCandleTime || 0)}`;
}

function persistentNotificationKey(type, signal) {
  return `${type}:${dailySignalKey(signal)}`;
}

async function sendTelegramBlock(text, dedupeKey) {
  if (!text) return null;

  return sendTelegramMessage(text, {
    dedupeKey,
    ttlMs: Number(config.TELEGRAM_DEDUPE_TTL_MS || 60000)
  });
}

async function getMarketDataCached(symbol) {
  const cached = marketDataCache.get(symbol);

  if (cached && Date.now() - cached.cachedAt < MARKET_DATA_CACHE_TTL_MS) {
    return cached.data;
  }

  const data = await buildMarketData(symbol);
  marketDataCache.set(symbol, {
    cachedAt: Date.now(),
    data
  });

  return data;
}

async function getCandles(symbol, timeframe) {
  return getLatestCandles(symbol, timeframe, 200);
}

async function getDailyRoot(symbol) {
  const dailyCandles = await getCandles(symbol, 'D');

  if (!Array.isArray(dailyCandles) || dailyCandles.length < 8) {
    monitoredRoots.delete(symbol);
    return null;
  }

  const marketData = await getMarketDataCached(symbol);
  const latestDailyCandle = dailyCandles[dailyCandles.length - 1];
  const dailyCandleTime = Number(latestDailyCandle?.open_time || 0) || null;

  const detectedRoot = detectDailyRootSignal(dailyCandles, {
    symbol,
    lastPrice: marketData.lastPrice
  });

  const previousMonitor = monitoredRoots.get(symbol);
  const sameDailyCandle =
    previousMonitor?.dailyCandleTime === dailyCandleTime;

  if (detectedRoot) {
    const root = { ...detectedRoot, symbol };

    monitoredRoots.set(symbol, {
      dailyCandleTime,
      root,
      signal: sameDailyCandle ? previousMonitor.signal : null,
      initialAlignmentCheckPending: sameDailyCandle
        ? previousMonitor.initialAlignmentCheckPending
        : true
    });

    return {
      root,
      dailyCandles,
      marketData,
      rootActive: true
    };
  }

  // Keep monitoring a root already discovered during this daily candle,
  // even if its original detection condition no longer passes.
  if (sameDailyCandle) {
    return {
      root: previousMonitor.root,
      dailyCandles,
      marketData,
      rootActive: true
    };
  }

  monitoredRoots.delete(symbol);
  return null;
}

function getMtfSnapshot(candlesByTf) {
  const values = {};
  const histogramValues = {};
  const previousHistogramValues = {};
  const flippedBullish = [];

  for (const timeframe of MTF_TIMEFRAMES) {
    const candles = Array.isArray(candlesByTf[timeframe])
      ? candlesByTf[timeframe]
      : [];

    const currentHistogram = candles.length >= 26
      ? Number(macdHistogram(candles))
      : null;

    // The final stored candle is treated as the currently forming candle.
    // Recalculate without it to get the previous candle's closed histogram.
    const previousHistogram = candles.length >= 27
      ? Number(macdHistogram(candles.slice(0, -1)))
      : null;

    histogramValues[timeframe] = currentHistogram;
    previousHistogramValues[timeframe] = previousHistogram;

    if (currentHistogram === null || !Number.isFinite(currentHistogram)) {
      values[timeframe] = 'neutral';
    } else if (currentHistogram > 0) {
      values[timeframe] = 'bullish';
    } else if (currentHistogram < 0) {
      values[timeframe] = 'negative';
    } else {
      values[timeframe] = 'neutral';
    }

    if (
      previousHistogram !== null &&
      Number.isFinite(previousHistogram) &&
      previousHistogram < 0 &&
      currentHistogram !== null &&
      Number.isFinite(currentHistogram) &&
      currentHistogram > 0
    ) {
      flippedBullish.push(timeframe);
    }
  }

  const aligned = MTF_TIMEFRAMES.every(
    (timeframe) => values[timeframe] === 'bullish'
  );

  let status = 'mixed';
  if (aligned) {
    status = 'bullish';
  } else if (
    MTF_TIMEFRAMES.every((timeframe) => values[timeframe] === 'negative')
  ) {
    status = 'negative';
  } else if (
    MTF_TIMEFRAMES.every((timeframe) => values[timeframe] === 'neutral')
  ) {
    status = 'neutral';
  }

  return {
    status,
    values,
    histogramValues,
    previousHistogramValues,
    aligned,
    flippedBullish
  };
}

function alertData(signal, marketData) {
  return {
    symbol: signal.symbol,
    time: new Date().toISOString(),
    decision: signal.decision || 'monitor',
    reason: signal.reason,
    customScore: signal.customScore,
    customScoreLabel: signal.customScoreLabel,
    tvScore: signal.tvScore,
    tvScorePercent: signal.tvScorePercent,
    tvScoreLabel: signal.tvScoreLabel,
    tvScoreAvailable: signal.tvScoreAvailable,
    mtfStatus: signal.mtfStatus,
    mtfValues: signal.mtfValues,
    price: Number(signal.price || marketData.lastPrice || 0),
    volume24h: Number(marketData.volume24hUsd || 0),
    spreadPct: Number(marketData.spreadPct || 0),
    liquidity: signal.liquidity?.valid ? 'valid' : 'invalid',
    trailingStop: 'higher_lows or close below 14MA',
    takeProfit: `${Number(config.DEFAULT_TP_PERCENT || 3)}%`,
    action: signal.decision === 'accept' ? 'open' : 'monitor'
  };
}

async function maybeSendAlignmentAlert(signal, marketData) {
  // The alert reports MTF alignment; it is not gated by trade acceptance
  // or liquidity. All configured MTF timeframes must be bullish.
  if (signal?.mtfAligned !== true) {
    return false;
  }

  const key = persistentNotificationKey(ALIGNMENT_PREFIX, signal);
  if (await notificationWasSent(key)) return false;

  const result = await sendTelegramBlock(
    formatMtfAlignmentAlert(alertData(signal, marketData)),
    key
  );

  if (!result) return false;

  await markNotificationSent(
    key,
    signal.symbol,
    signal.dailyCandleTime,
    signal.reason
  );

  return true;
}

function queueTradeCandidate(signal, marketData) {
  const market = {
    volume24hUsd: Number(marketData?.volume24hUsd || 0),
    spreadPct: Number(marketData?.spreadPct ?? 0.02),
    topOfBookDepthUsd: Number(marketData?.topOfBookDepthUsd || 0)
  };

  const eligibility = shouldOpenTrade(signal, market);
  if (!eligibility.open) return;

  const key = dailySignalKey(signal);
  tradeCandidates.set(key, { signal, marketData, market });

  if (tradeQueueTimer) return;

  tradeQueueTimer = setTimeout(() => {
    tradeQueueTimer = null;
    void flushTradeCandidateQueue();
  }, TRADE_RANKING_WINDOW_MS);
}

async function flushTradeCandidateQueue() {
  const candidates = rankTradeCandidates([...tradeCandidates.values()]);
  tradeCandidates.clear();

  for (const candidate of candidates) {
    const { signal, marketData, market } = candidate;
    const key = persistentNotificationKey(RECOMMENDATION_PREFIX, signal);

    try {
      if (await notificationWasSent(key)) continue;

      if (await countOpenTrades() >= Number(config.MAX_OPEN_TRADES || 3)) {
        break;
      }

      const eligibility = shouldOpenTrade(signal, market);
      if (!eligibility.open) continue;

      const plan = buildTradePlan(signal, market);
      const savedTrade = await ensureTradeFromSignal(signal, plan);
      if (!savedTrade) continue;

      const result = await sendTelegramBlock(
        formatRecommendationTelegram({
          symbol: signal.symbol,
          action: 'open',
          tvScore: signal.tvScore,
          tvScoreAvailable: signal.tvScoreAvailable,
          tvScorePercent: signal.tvScorePercent,
          tvScoreLabel: signal.tvScoreLabel,
          customScore: signal.customScore,
          customScoreLabel: signal.customScoreLabel,
          mtfStatus: signal.mtfStatus,
          mtfValues: signal.mtfValues,
          liquidity: signal.liquidity?.valid ? 'valid' : 'invalid',
          reason: signal.reason,
          plan
        }),
        key
      );

      if (result) {
        await markNotificationSent(
          key,
          signal.symbol,
          signal.dailyCandleTime,
          signal.reason
        );
      }
    } catch (error) {
      console.error(
        `Trade candidate processing failed for ${signal.symbol}:`,
        error.message
      );
    }

    if (config.TELEGRAM_SEND_DELAY_MS > 0) {
      await delay(config.TELEGRAM_SEND_DELAY_MS);
    }
  }
}

function buildAlignmentSignal(root, baseSignal, snapshot, marketData) {
  const dailyCandleTime =
    Number(baseSignal?.dailyCandleTime || root?.dailyCandleTime || 0) || null;

  return {
    ...(baseSignal || {}),
    symbol: root.symbol,
    timeframe: 'D',
    dailyCandleTime,
    decision: baseSignal?.decision || 'monitor',
    reason: baseSignal?.reason || root.reason || '1D root signal',
    mtfStatus: snapshot.status,
    mtfValues: snapshot.values,
    mtfHistogramValues: snapshot.histogramValues,
    mtfPreviousHistogramValues: snapshot.previousHistogramValues,
    mtfAligned: snapshot.aligned,
    mtfFlippedBullish: snapshot.flippedBullish,
    price: Number(marketData.lastPrice || baseSignal?.price || 0)
  };
}

async function evaluateSymbol(symbol, { sendAlerts = true } = {}) {
  const daily = await getDailyRoot(symbol);
  if (!daily) return null;

  const monitor = monitoredRoots.get(symbol);
  if (!monitor) return null;

  const mtfCandles = {};
  for (const timeframe of MTF_TIMEFRAMES) {
    mtfCandles[timeframe] = await getCandles(symbol, timeframe);
  }

  const snapshot = getMtfSnapshot(mtfCandles);
  const initialAlignmentCheckPending =
    monitor.initialAlignmentCheckPending === true;

  // If the root was discovered already aligned, alert on this first check.
  // Otherwise, wait until all MTFs are positive and a lagging TF flips from
  // negative on its previous closed candle to positive on its current candle.
  const alignmentTrigger =
    snapshot.aligned &&
    (
      initialAlignmentCheckPending ||
      snapshot.flippedBullish.length > 0
    );

  monitor.initialAlignmentCheckPending = false;

  let signal = monitor.signal;

  // Preserve the existing signal evaluation and trade flow. Run it in the
  // background so its TradingView request cannot hold up an MTF alert.
  if (!signal && !monitor.signalEvaluationStarted) {
    monitor.signalEvaluationStarted = true;

    void evaluateSignal(
      symbol,
      { ...mtfCandles, D: daily.dailyCandles },
      daily.marketData
    )
      .then(async (evaluatedSignal) => {
        if (!evaluatedSignal) return;

        const currentMonitor = monitoredRoots.get(symbol);
        if (
          !currentMonitor ||
          currentMonitor.dailyCandleTime !== monitor.dailyCandleTime
        ) {
          return;
        }

        currentMonitor.signal = evaluatedSignal;
        await recordSignal(evaluatedSignal);

        if (sendAlerts) {
          queueTradeCandidate(evaluatedSignal, daily.marketData);
        }
      })
      .catch((error) => {
        console.error(`Signal evaluation failed for ${symbol}:`, error);
      });
  }

  signal = buildAlignmentSignal(
    daily.root,
    signal,
    snapshot,
    daily.marketData
  );

  if (sendAlerts && alignmentTrigger) {
    await maybeSendAlignmentAlert(signal, daily.marketData);
  }

  if (monitor.signal) {
    const updatedSignal = {
      ...monitor.signal,
      mtfStatus: snapshot.status,
      mtfValues: snapshot.values,
      mtfHistogramValues: snapshot.histogramValues,
      mtfPreviousHistogramValues: snapshot.previousHistogramValues,
      mtfAligned: snapshot.aligned,
      mtfFlippedBullish: snapshot.flippedBullish
    };

    monitor.signal = updatedSignal;
    await recordSignal(updatedSignal);

    if (sendAlerts && snapshot.aligned) {
      queueTradeCandidate(updatedSignal, daily.marketData);
    }
  }

  return {
    root: daily.root,
    signal,
    marketData: daily.marketData
  };
}

function normalizeWsCandle(msg) {
  const candle = msg?.data?.[0] || msg?.data;
  if (!candle) return null;

  return {
    open_time: Number(candle.start || candle.t || candle.open_time || 0),
    open: Number(candle.open || candle.o || 0),
    high: Number(candle.high || candle.h || 0),
    low: Number(candle.low || candle.l || 0),
    close: Number(candle.close || candle.c || 0),
    volume: Number(candle.volume || candle.v || 0)
  };
}

function parseKlineTopic(topic) {
  const parts = String(topic || '').split('.');
  if (parts.length < 3 || parts[0] !== 'kline') return null;

  return {
    timeframe: parts[1],
    symbol: parts.slice(2).join('.')
  };
}

async function handleKline(msg) {
  const details = parseKlineTopic(msg?.topic);
  if (!details || !TIMEFRAMES.includes(details.timeframe)) return;

  const candle = normalizeWsCandle(msg);
  if (!candle?.open_time) return;

  const bufferKey = `${details.symbol}:${details.timeframe}`;

  if (seedingHistory) {
    const previous = bufferedKlines.get(bufferKey);
    if (!previous || candle.open_time >= previous.candle.open_time) {
      bufferedKlines.set(bufferKey, {
        symbol: details.symbol,
        timeframe: details.timeframe,
        candle
      });
    }
    return;
  }

  try {
    await saveKline(details.symbol, details.timeframe, candle);
    scheduleSymbolEvaluation(details.symbol);

    if (details.timeframe === 'D') {
      await syncOpenTradesFromMarket();
    }
  } catch (error) {
    console.error(`Failed to store WS candle for ${details.symbol}:`, error);
  }
}

function scheduleSymbolEvaluation(symbol) {
  if (!symbol) return;

  const oldTimer = pendingEvaluations.get(symbol);
  if (oldTimer) clearTimeout(oldTimer);

  const timer = setTimeout(() => {
    pendingEvaluations.delete(symbol);
    void processSymbol(symbol);
  }, EVALUATION_DEBOUNCE_MS);

  pendingEvaluations.set(symbol, timer);
}

async function processSymbol(symbol) {
  if (!startupReady) {
    deferredSymbols.add(symbol);
    return;
  }

  // Do not defer WebSocket updates just because a whole-market scan is running.
  // Serialize evaluations for the same symbol and rerun if another update
  // arrived while the current evaluation was in progress.
  if (evaluatingSymbols.has(symbol)) {
    deferredSymbols.add(symbol);
    return;
  }

  evaluatingSymbols.add(symbol);

  try {
    await evaluateSymbol(symbol);
  } catch (error) {
    console.error(`Signal evaluation failed for ${symbol}:`, error);
  } finally {
    evaluatingSymbols.delete(symbol);

    if (deferredSymbols.delete(symbol)) {
      scheduleSymbolEvaluation(symbol);
    }
  }
}

function handleMarketUpdate(symbol) {
  if (!symbol) return;

  // Clear cache so next check sees latest price/book.
  marketDataCache.delete(symbol);
  scheduleSymbolEvaluation(symbol);
}

async function discoverSymbols() {
  let instruments;

  if (Array.isArray(config.WATCH_SYMBOLS) && config.WATCH_SYMBOLS.length > 0) {
    instruments = config.WATCH_SYMBOLS
      .map((rawSymbol) => String(rawSymbol).trim().toUpperCase())
      .filter(Boolean)
      .map((symbol) => ({
        symbol,
        base: symbol.replace(/USDT(\.P)?$/i, ''),
        quote: 'USDT'
      }));
  } else {
    instruments = await fetchAllSymbols();
  }

  const selected = filterUsdtPerpetualSymbols(instruments);
  const maxSymbols = Number(config.STARTUP_SCAN_MAX_SYMBOLS || 0);

  const finalSymbols = maxSymbols > 0
    ? selected.slice(0, maxSymbols)
    : selected;

  const instrumentBySymbol = new Map(
    instruments.map((item) => [String(item.symbol).toUpperCase(), item])
  );

  for (const symbol of finalSymbols) {
    const instrument = instrumentBySymbol.get(symbol);

    await upsertSymbol(
      symbol,
      instrument?.base || symbol.replace(/USDT(\.P)?$/i, ''),
      instrument?.quote || 'USDT',
      'active'
    );

    symbols.add(symbol);
  }

  if (!symbols.size) {
    throw new Error(
      'No symbols selected. Set WATCH_SYMBOLS or check symbol discovery/filter settings.'
    );
  }

  return [...symbols];
}

async function seedHistoricalCandles(symbolList) {
  const requestedLimit = Number(config.SEED_KLINES_LIMIT || 120);
  const limit = Math.max(26, Math.min(200, requestedLimit));
  const concurrency = Math.max(1, Number(config.SEED_CONCURRENCY || 1));
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= symbolList.length) return;

      const symbol = symbolList[index];

      for (const timeframe of TIMEFRAMES) {
        try {
          const candles = await fetchKlines(symbol, timeframe, limit);
          if (Array.isArray(candles) && candles.length > 0) {
            await saveKlines(symbol, timeframe, candles);
          }
        } catch (error) {
          console.error(
            `History seed failed for ${symbol} ${timeframe}:`,
            error.message
          );
        }
      }
    }
  }

  const workerCount = Math.min(concurrency, symbolList.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

function rootSummaryKey(root) {
  return persistentNotificationKey(ROOT_SUMMARY_PREFIX, root);
}

async function sendRootSummary(roots, scanType) {
  const unseen = [];

  for (const root of roots) {
    const key = rootSummaryKey(root);
    if (!(await notificationWasSent(key))) {
      unseen.push({ ...root, summaryKey: key });
    }
  }

  if (unseen.length === 0) {
    if (scanType === 'boundary') {
      await sendTelegramBlock(
        'No new root signals at this scan interval.',
        `no-new-root:${Date.now()}`
      );
    }
    return [];
  }

  const chunks = formatSummaryTelegramChunks(unseen);
  const batchKey = `${scanType}:${unseen
    .map((root) => root.summaryKey)
    .sort()
    .join('|')}`;

  let allChunksSent = true;

  for (let index = 0; index < chunks.length; index++) {
    const result = await sendTelegramBlock(
      chunks[index],
      `${batchKey}:chunk:${index}`
    );

    if (!result) allChunksSent = false;

    if (config.TELEGRAM_SEND_DELAY_MS > 0) {
      await delay(config.TELEGRAM_SEND_DELAY_MS);
    }
  }

  if (allChunksSent) {
    for (const root of unseen) {
      await markNotificationSent(
        root.summaryKey,
        root.symbol,
        root.dailyCandleTime,
        root.reason
      );
    }

    return unseen;
  }

  return [];
}

async function collectCurrentRoots(symbolList) {
  const roots = [];

  for (const symbol of symbolList) {
    try {
      const result = await getDailyRoot(symbol);
      if (!result) continue;

      roots.push({
        symbol,
        dailyCandleTime: result.root.dailyCandleTime,
        reason: result.root.reason
      });
    } catch (error) {
      console.error(`Root scan failed for ${symbol}:`, error.message);
    }
  }

  return roots;
}

async function dispatchRoots(roots) {
  for (const root of roots) {
    try {
      await evaluateSymbol(root.symbol);

      if (config.TELEGRAM_SEND_DELAY_MS > 0) {
        await delay(config.TELEGRAM_SEND_DELAY_MS);
      }
    } catch (error) {
      console.error(`MTF evaluation failed for ${root.symbol}:`, error.message);
    }
  }
}

async function runInitialScan(symbolList) {
  batchScanRunning = true;

  try {
    const roots = await collectCurrentRoots(symbolList);

    await sendRootSummary(roots, 'startup');
    await dispatchRoots(roots);
  } finally {
    batchScanRunning = false;
  }
}

async function runBoundaryScan() {
  if (boundaryScanRunning) return;

  boundaryScanRunning = true;
  batchScanRunning = true;

  try {
    const roots = await collectCurrentRoots([...symbols]);

    await sendRootSummary(roots, 'boundary');
    await dispatchRoots(roots);
  } catch (error) {
    console.error('Boundary scan failed:', error);
  } finally {
    batchScanRunning = false;
    boundaryScanRunning = false;
    await drainDeferredSymbols();
  }
}

async function drainDeferredSymbols() {
  if (!startupReady || deferredSymbols.size === 0) return;

  const pending = [...deferredSymbols];
  deferredSymbols.clear();

  for (const symbol of pending) {
    scheduleSymbolEvaluation(symbol);
  }
}

function nextWallClockBoundaryDelayMs() {
  const interval = Math.max(
    60000,
    Number(config.BOUNDARY_SCAN_INTERVAL_MS || 15 * 60 * 1000)
  );

  const remainder = Date.now() % interval;
  return remainder === 0 ? interval : interval - remainder;
}

function scheduleNextBoundary() {
  const timer = setTimeout(async () => {
    await runBoundaryScan();
    scheduleNextBoundary();
  }, nextWallClockBoundaryDelayMs());

  timer.unref?.();
}

async function performDailyCleanup() {
  if (cleanupRunning) return;

  const interval = Number(
    config.DAILY_CLEANUP_INTERVAL_MS || 24 * 60 * 60 * 1000
  );

  if (Date.now() - lastCleanupAt < interval) return;

  cleanupRunning = true;

  try {
    await purgeStaleCache();

    if (typeof bybitWs.cleanupCache === 'function') {
      bybitWs.cleanupCache(interval);
    }

    lastCleanupAt = Date.now();
  } catch (error) {
    console.error('Daily cache cleanup failed:', error);
  } finally {
    cleanupRunning = false;
  }
}

async function syncOpenTradesFromMarket() {
  const trades = await listOpenTrades();

  for (const trade of trades) {
    try {
      const marketData = await getMarketDataCached(trade.symbol);
      const dailyCandles = await getCandles(trade.symbol, 'D');
      const currentPrice = Number(marketData.lastPrice || 0);

      if (currentPrice > 0) {
        await updateTradeFromMarket(
          trade.symbol,
          currentPrice,
          dailyCandles
        );
      }
    } catch (error) {
      console.error(
        `Open-trade sync failed for ${trade.symbol}:`,
        error.message
      );
    }
  }
}

async function replayBufferedKlines() {
  const buffered = [...bufferedKlines.values()];
  bufferedKlines.clear();

  for (const item of buffered) {
    await saveKline(item.symbol, item.timeframe, item.candle);
  }
}

async function waitForWebSocketSnapshots(timeoutMs) {
  const wait = Math.max(0, Number(timeoutMs || 0));
  if (wait > 0) await delay(wait);
}

async function bootstrapStrategy() {
  if (bootstrapped) return;
  bootstrapped = true;

  setupKeepAlive();

  if (!config.USE_WS) {
    throw new Error(
      'This strategyEngine requires USE_WS=true for live operation.'
    );
  }

  const symbolList = await discoverSymbols();

  bybitWs.on('kline', handleKline);
  bybitWs.on('market', handleMarketUpdate);
  bybitWs.connect();

  // Keep the existing WebSocket subscription behavior.
  bybitWs.subscribe(symbolList, TIMEFRAMES);

  seedingHistory = true;
  try {
    await seedHistoricalCandles(symbolList);
  } finally {
    seedingHistory = false;
  }

  await replayBufferedKlines();
  await waitForWebSocketSnapshots(config.WS_INITIAL_SCAN_TIMEOUT);
  await performDailyCleanup();

  // Enable live evaluations before the whole-market startup scan completes.
  startupReady = true;

  await runInitialScan(symbolList);
  await drainDeferredSymbols();

  const cleanupInterval = Number(
    config.DAILY_CLEANUP_INTERVAL_MS || 24 * 60 * 60 * 1000
  );

  if (cleanupInterval > 0) {
    const cleanupTimer = setInterval(
      () => void performDailyCleanup(),
      cleanupInterval
    );

    cleanupTimer.unref?.();
  }

  if (config.ENABLE_BOUNDARY_SCAN) {
    scheduleNextBoundary();
  }
}

module.exports = {
  bootstrapStrategy,
  performDailyCleanup,
  evaluateAndDispatchSymbol: evaluateSymbol,
  syncOpenTradesFromMarket,
  runBoundaryScan
};
