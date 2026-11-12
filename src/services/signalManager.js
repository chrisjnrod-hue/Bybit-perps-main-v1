const config = require('../config');
const { getMtfState, setMtfState, recordSignal } = require('../db');
const { evaluateMtfAlignment } = require('./mtfAlignment');
const { sma } = require('./ma');
const { macdHistogram, detectBullishHistogramFlip } = require('./macd');
const { calculateCustomRating } = require('./customRatingEngine');
const { getTradingViewRating } = require('./tradingviewRating');
const {
  checkLiquidity,
  getAccountEquity,
  CONFIG: liquidityConfig
} = require('./liquidityGuard');

function hasLiveAccountConfig() {
  return Boolean(
    config.BYBIT_API_KEY &&
    config.BYBIT_API_SECRET &&
    String(config.BYBIT_API_KEY).trim() &&
    String(config.BYBIT_API_SECRET).trim()
  );
}

function getCurrentPrice(ticker, latestDailyCandle) {
  const tickerPrice = Number(ticker?.lastPrice || ticker?.last || 0);
  if (tickerPrice > 0) return tickerPrice;

  return Number(latestDailyCandle?.close || latestDailyCandle?.open || 0);
}

function detectDailyRootSignal(daily = [], ticker = {}) {
  if (!Array.isArray(daily) || daily.length < 8) return null;

  const latest = daily[daily.length - 1];
  const currentOpen = Number(latest?.open || 0);
  const currentPrice = getCurrentPrice(ticker, latest);
  const recentCloses = daily
    .slice(-8, -1)
    .map((candle) => Number(candle.close || 0));

  if (recentCloses.length < 7) return null;

  const ma7 = sma(recentCloses, 7);
  const openAndPriceAboveMa7 = currentOpen > ma7 && currentPrice > ma7;
  const positiveFlip = detectBullishHistogramFlip(daily);

  if (!openAndPriceAboveMa7 && !positiveFlip) return null;

  return {
    symbol: ticker.symbol || null,
    dailyCandleTime: Number(latest?.open_time || 0) || null,
    currentOpen,
    currentPrice,
    ma7,
    openAndPriceAboveMa7,
    positiveFlip,
    reason: openAndPriceAboveMa7
      ? '1D open and current price above 7MA'
      : '1D open-candle histogram flipped positive after prior closed candle was negative'
  };
}

async function buildMarketSignal(
  symbol,
  candlesByTf = {},
  ticker = {},
  { rootActive = false } = {}
) {
  const daily = Array.isArray(candlesByTf.D) ? candlesByTf.D : [];
  if (daily.length < 8) return null;

  const latestDailyCandle = daily[daily.length - 1];
  const currentPrice = getCurrentPrice(ticker, latestDailyCandle);
  const currentOpen = Number(latestDailyCandle?.open || 0);

  const recentCloses = daily
    .slice(-8, -1)
    .map((candle) => Number(candle.close || 0));

  if (recentCloses.length < 7) return null;

  const ma7 = sma(recentCloses, 7);
  const openAndPriceAboveMa7 = currentOpen > ma7 && currentPrice > ma7;

  const currentDailyHistogram = macdHistogram(daily);
  const dailyHistogramDirection =
    currentDailyHistogram > 0
      ? 'bullish'
      : currentDailyHistogram < 0
        ? 'negative'
        : 'neutral';

  const positiveFlip = detectBullishHistogramFlip(daily);

  if (!rootActive && !openAndPriceAboveMa7 && !positiveFlip) {
    return null;
  }

  const mtf = evaluateMtfAlignment({
    '5': candlesByTf['5'] || [],
    '15': candlesByTf['15'] || [],
    '60': candlesByTf['60'] || [],
    '240': candlesByTf['240'] || []
  });

  let reason = '1D root signal';
  if (openAndPriceAboveMa7 && positiveFlip) {
    reason = '1D open and current price above 7MA with positive hist flip';
  } else if (openAndPriceAboveMa7) {
    reason = '1D open and current price above 7MA';
  } else if (positiveFlip) {
    reason = '1D open-candle histogram flipped positive after prior closed candle was negative';
  }

  const previousState = await getMtfState(symbol, 'D');

  const signal = {
    symbol,
    timeframe: 'D',
    dailyCandleTime: Number(latestDailyCandle?.open_time || 0) || null,
    decision: mtf.aligned ? 'accept' : 'monitor',
    reason,

    dailyHistogram: currentDailyHistogram,
    dailyHistogramDirection,
    macdFlip: positiveFlip,
    openAboveMa7: openAndPriceAboveMa7,
    priceAboveMa7: currentPrice > ma7,

    customScore: 0,
    customScoreLabel: 'Market-only',

    tvScore: null,
    tvScorePercent: null,
    tvScoreLabel: 'Pending',
    tvScoreAvailable: false,

    mtfStatus: mtf.status,
    mtfValues: mtf.values,
    mtfPreviousValues: mtf.previousValues,
    mtfHistogramValues: mtf.histogramValues,
    mtfPreviousHistogramValues: mtf.previousHistogramValues,
    mtfAligned: mtf.aligned,
    mtfAlignmentFlip: mtf.alignmentFlip,
    mtfFlippedBullish: mtf.flippedBullish,

    status: mtf.aligned ? 'new' : 'monitor',
    price: currentPrice,
    liquidity: { valid: true },

    mtfTransition:
      previousState?.state && previousState.state !== mtf.status
        ? `${previousState.state}->${mtf.status}`
        : 'stable',

    requiresLiveAccount: false
  };

  await setMtfState(symbol, 'D', mtf.status);

  return signal;
}

async function evaluateSignal(
  symbol,
  candlesByTf = {},
  ticker = {},
  { rootActive = false } = {}
) {
  const marketSignal = await buildMarketSignal(symbol, candlesByTf, ticker, { rootActive });

  if (!marketSignal) return null;

  // DO NOT require account keys for the market-only signal.
  if (!hasLiveAccountConfig()) {
    await recordSignal(marketSignal);
    return marketSignal;
  }

  const daily = Array.isArray(candlesByTf.D) ? candlesByTf.D : [];
  const latestDailyCandle = daily[daily.length - 1];
  const currentPrice = getCurrentPrice(ticker, latestDailyCandle);

  const { totalEquityUsd } = await getAccountEquity();

  if (!Number.isFinite(totalEquityUsd) || totalEquityUsd <= 0) {
    throw new Error('Live account equity is unavailable; refusing liquidity evaluation.');
  }

  const targetPositionUsd =
    (totalEquityUsd * liquidityConfig.riskPercentage) /
    liquidityConfig.stopLossPercentage;

  const liquidity = checkLiquidity(
    {
      symbol,
      lastPrice: currentPrice,
      volume24hUsd: Number(ticker?.volume24hUsd || ticker?.turnover24h || 0),
      spreadPct: Number(ticker?.spreadPct || 0),
      topOfBookDepthUsd: Number(ticker?.topOfBookDepthUsd || 0)
    },
    targetPositionUsd
  );

  const customRating = calculateCustomRating({
    macdFlip: marketSignal.macdFlip,
    openAboveMa7: marketSignal.openAboveMa7,
    mtfStatus: marketSignal.mtfStatus,
    liquidityValid: liquidity.valid,
    marketTrend: marketSignal.mtfAligned ? 'strong' : 'mixed',
    priceBelow14Ma: false
  });

  const decision = marketSignal.mtfAligned && liquidity.valid ? 'accept' : 'monitor';

  marketSignal.decision = decision;
  marketSignal.status = decision === 'accept' ? 'new' : 'monitor';
  marketSignal.customScore = customRating.score;
  marketSignal.customScoreLabel = customRating.label;
  marketSignal.liquidity = liquidity;
  marketSignal.requiresLiveAccount = true;

  await recordSignal(marketSignal);

  // TV data is optional and should not block the MTF alert.
  void getTradingViewRating(symbol)
    .then(async (tvRating) => {
      marketSignal.tvScore = tvRating.available ? tvRating.score : null;
      marketSignal.tvScorePercent = tvRating.available ? tvRating.percent : null;
      marketSignal.tvScoreLabel = tvRating.label;
      marketSignal.tvScoreAvailable = tvRating.available;

      await recordSignal(marketSignal);
    })
    .catch((error) => {
      console.error(
        `[signalManager] TradingView rating update failed for ${symbol}:`,
        error.message
      );
    });

  return marketSignal;
}

module.exports = {
  evaluateSignal,
  detectDailyRootSignal
};
