const config = require('../config');
const { getMtfState, setMtfState, recordSignal } = require('../db');
const { evaluateMtfAlignment } = require('./mtfAlignment');
const { sma } = require('./ma');
const { macdHistogram, detectBullishHistogramFlip } = require('./macd');
const { calculateCustomRating } = require('./customRatingEngine');
const { getTradingViewRating } = require('./tradingviewRating');
const { checkLiquidity } = require('./liquidityGuard');

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

async function evaluateSignal(
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

  // Once a daily root has been discovered, the strategy engine can keep
  // monitoring it until this daily candle expires.
  if (!rootActive && !openAndPriceAboveMa7 && !positiveFlip) {
    return null;
  }

  const mtf = evaluateMtfAlignment({
    '5': candlesByTf['5'] || [],
    '15': candlesByTf['15'] || [],
    '60': candlesByTf['60'] || [],
    '240': candlesByTf['240'] || []
  });

  const liquidity = checkLiquidity(
    {
      volume24hUsd: Number(ticker?.volume24hUsd || ticker?.turnover24h || 0),
      spreadPct: Number(ticker?.spreadPct || 0),
      topOfBookDepthUsd: Number(ticker?.topOfBookDepthUsd || 0)
    },
    Number(config.DEFAULT_ACCOUNT_EQUITY_USD || 10000),
    Number(config.TARGET_POSITION_FRAC || 0.01)
  );

  const customRating = calculateCustomRating({
    macdFlip: positiveFlip,
    openAboveMa7: openAndPriceAboveMa7,
    mtfStatus: mtf.status,
    liquidityValid: liquidity.valid,
    marketTrend: mtf.aligned ? 'strong' : 'mixed',
    priceBelow14Ma: false
  });

  const previousState = await getMtfState(symbol, 'D');
  const decision = mtf.aligned && liquidity.valid ? 'accept' : 'monitor';

  let reason = '1D root signal';
  if (openAndPriceAboveMa7 && positiveFlip) {
    reason = '1D open and current price above 7MA with positive hist flip';
  } else if (openAndPriceAboveMa7) {
    reason = '1D open and current price above 7MA';
  } else if (positiveFlip) {
    reason = '1D open-candle histogram flipped positive after prior closed candle was negative';
  }

  const signal = {
    symbol,
    timeframe: 'D',
    dailyCandleTime: Number(latestDailyCandle?.open_time || 0) || null,
    decision,
    reason,

    dailyHistogram: currentDailyHistogram,
    dailyHistogramDirection,
    macdFlip: positiveFlip,
    openAboveMa7: openAndPriceAboveMa7,
    priceAboveMa7: currentPrice > ma7,

    customScore: customRating.score,
    customScoreLabel: customRating.label,

    // The TV lookup runs in the background so it cannot delay the MTF alert.
    // Configure a supported rating provider endpoint to populate these fields.
    customRating,
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

    status: decision === 'accept' ? 'new' : 'monitor',
    price: currentPrice,
    liquidity,

    mtfTransition:
      previousState?.state && previousState.state !== mtf.status
        ? `${previousState.state}->${mtf.status}`
        : 'stable'
  };

  await setMtfState(symbol, 'D', mtf.status);
  await recordSignal(signal);

  // Start the optional TV lookup without waiting for its network response.
  void getTradingViewRating(symbol)
    .then(async (tvRating) => {
      signal.tvScore = tvRating.available ? tvRating.score : null;
      signal.tvScorePercent = tvRating.available ? tvRating.percent : null;
      signal.tvScoreLabel = tvRating.label;
      signal.tvScoreAvailable = tvRating.available;

      await recordSignal(signal);
    })
    .catch((error) => {
      console.error(
        `[signalManager] TradingView rating update failed for ${symbol}:`,
        error.message
      );
    });

  return signal;
}

module.exports = {
  evaluateSignal,
  detectDailyRootSignal
};
