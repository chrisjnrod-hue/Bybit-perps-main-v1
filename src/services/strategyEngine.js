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
const BYBIT_TF_MS = {
  '5': 5 * 60 * 1000,
  '15': 15 * 60 * 1000,
  '60': 60 * 60 * 1000,
  '240': 4 * 60 * 60 * 1000,
  D: 24 * 60 * 60 * 1000
};

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasLiveAccountConfig() {
  return Boolean(
    config.BYBIT_API_KEY &&
    config.BYBIT_API_SECRET &&
    String(config.BYBIT_API_KEY).trim() &&
    String(config.BYBIT_API_SECRET).trim()
  );
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
    return null;
  }

  const marketData = await getMarketDataCached(symbol);
  const root = detectDailyRootSignal(dailyCandles, {
    symbol,
    lastPrice: marketData.lastPrice
  });

  if (!root) return null;

  return {
    root: { ...root, symbol },
    dailyCandles,
    marketData
  };
}

function alertData(signal, marketData) {
  return {
    symbol: signal.symbol,
    time: new Date().toISOString(),
    decision: signal.decision,
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

function isFinalBullishMtfFlip(signal) {
  const current = signal?.mtfValues || {};
  const previous = signal?.mtfPreviousValues || {};

  const required = ['5', '15', '60', '240'];

  const allCurrentBullish = required.every((tf) => {
    const value = current[tf];
    return (
      value === true ||
      String(value).toLowerCase() === 'bullish' ||
      String(value).toLowerCase() === 'positive' ||
      Number(value) > 0
    );
  });

  if (allCurrentBullish) return true;

  const latestFlipTf = signal?.latestFlippedBullishTimeframe || signal?.mtfLatestFlippedBullish || null;

  if (!latestFlipTf) return false;

  const now = current[latestFlipTf];
  const prev = previous[latestFlipTf];

  const nowBullish =
    now === true ||
    String(now).toLowerCase() === 'bullish' ||
    String(now).toLowerCase() === 'positive' ||
    Number(now) > 0;

  const prevNegative =
    prev === false ||
    String(prev).toLowerCase() === 'negative' ||
    String(prev).toLowerCase() === 'bearish' ||
    Number(prev) < 0;

  return nowBullish && prevNegative;
}

async function maybeSendAlignmentAlert(signal, marketData) {
  if (!signal || !signal.symbol) return false;

  const rootReady =
    signal?.mtfAligned === true &&
    signal?.mtfStatus === 'bullish';

  const flipReady = isFinalBullishMtfFlip(signal);

  if (!rootReady && !flipReady) {
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

async function evaluateSymbol(symbol, { sendAlerts = true } = {}) {
  const daily = await getDailyRoot(symbol);
  if (!daily) return null;

  const mtfCandles = {};
  for (const timeframe of MTF_TIMEFRAMES) {
    mtfCandles[timeframe] = await getCandles(symbol, timeframe);
  }

  const signal = await evaluateSignal(
    symbol,
    { ...mtfCandles, D: daily.dailyCandles },
    daily.marketData
  );

  if (!signal) return null;

  await recordSignal(signal);

  if (sendAlerts) {
    await maybeSendAlignmentAlert(signal, daily.marketData);

    if (hasLiveAccountConfig()) {
      queueTradeCandidate(signal, daily.marketData);
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
  if (!startupReady || batchScanRunning) {
    deferredSymbols.add(symbol);
    return;
  }

  try {
    await evaluateSymbol(symbol);
  } catch (error) {
    console.error(`Signal evaluation failed for ${symbol}:`, error);
  }
}

function handleMarketUpdate(symbol) {
  if (!symbol) return;

  marketDataCache.delete(symbol);
  scheduleSymbolEvaluation(symbol);
}

async function discoverSymbols() {
  let instruments = await fetchAllSymbols();

  const selected = filterUsdtPerpetualSymbols(instruments);
  const instrumentBySymbol = new Map(
    instruments.map((item) => [String(item.symbol).toUpperCase(), item])
  );

  for (const symbol of selected) {
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
      'No symbols selected. Check symbol discovery/filter settings.'
    );
  }

  return [...symbols];
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
  const rootsToSend = (roots || []).map((root) => ({
    ...root,
    summaryKey: rootSummaryKey(root)
  }));

  if (rootsToSend.length === 0) {
    if (scanType === 'boundary') {
      await sendTelegramBlock(
        'No new root signals at this scan interval.',
        `no-new-root:${Date.now()}`
      );
    }
    return [];
  }

  const chunks = formatSummaryTelegramChunks(rootsToSend);
  const batchKey = `${scanType}:${Date.now()}`;

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
    for (const root of rootsToSend) {
      await markNotificationSent(
        root.summaryKey,
        root.symbol,
        root.dailyCandleTime,
        root.reason
      );
    }
    return rootsToSend;
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
      const evaluated = await evaluateSymbol(root.symbol);
      if (!evaluated) continue;

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
  if (!startupReady || batchScanRunning || deferredSymbols.size === 0) return;

  const pending = [...deferredSymbols];
  deferredSymbols.clear();

  for (const symbol of pending) {
    void processSymbol(symbol);
  }
}

function resolveBoundaryScanTimeframe() {
  const configuredMs = Number(config.BOUNDARY_SCAN_INTERVAL_MS || 15 * 60 * 1000);

  const exact = Object.entries(BYBIT_TF_MS).find(([, ms]) => ms === configuredMs);
  if (exact) return exact[0];

  const sorted = Object.entries(BYBIT_TF_MS).sort((a, b) => a[1] - b[1]);
  for (const [tf, ms] of sorted) {
    if (configuredMs <= ms) return tf;
  }

  return '15';
}

function nextWallClockBoundaryDelayMs(timeframe = '15') {
  const intervalMs = BYBIT_TF_MS[String(timeframe)] || BYBIT_TF_MS['15'];
  const now = Date.now();

  // Align to the next exact Bybit interval boundary.
  const nextBoundary = Math.ceil(now / intervalMs) * intervalMs;

  return Math.max(250, nextBoundary - now);
}

function scheduleNextBoundary() {
  const timeframe = resolveBoundaryScanTimeframe();

  const timer = setTimeout(async () => {
    await runBoundaryScan();
    scheduleNextBoundary();
  }, nextWallClockBoundaryDelayMs(timeframe));

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
  await runInitialScan(symbolList);

  startupReady = true;
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
