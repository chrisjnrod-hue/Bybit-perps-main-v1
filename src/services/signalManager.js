const config = require('../config');
const { getMtfState, setMtfState, recordSignal } = require('../db');
const { evaluateMtfAlignment } = require('./mtfAlignment');
const { sma } = require('./ma');
const { macdSeries, macdHistogram } = require('./macd');
const { calculateCustomRating } = require('./customRatingEngine');
const { getTradingViewRating } = require('./tradingviewRating');
const {
  checkLiquidity,
  getAccountEquity,
  CONFIG: liquidityConfig
} = require('./liquidityGuard');

const lastMtfSnapshots = new Map();

function getCurrentPrice(ticker, latestDailyCandle) {
  const tickerPrice = Number(ticker?.lastPrice || ticker?.last || 0);
  if (tickerPrice > 0) return tickerPrice;

  return Number(latestDailyCandle?.close || latestDailyCandle?.open || 0);
}

function detectStrictBullishDailyFlip(daily = []) {
  if (!Array.isArray(daily) || daily.length < 27) return false;
  const { histogram } = macdSeries(daily, { useOpenForLastCandle: true });
  if (histogram.length < 2) return false;

  const prev = histogram[histogram.length - 2];
  const curr = histogram[histogram.length - 1];

  return Number.isFinite(prev) && Number.isFinite(curr) && prev < 0 && curr > 0;
}

function evaluateDailyRootCriteria(daily = [], ticker = {}) {
  if (!Array.isArray(daily) || daily.length < 8) return null;

  const latest = daily[daily.length - 1];
  const currentOpen = Number(latest?.open || 0);
  const currentPrice = getCurrentPrice(ticker, latest);
  const recentCloses = daily
    .slice(-8, -1)
    .map((candle) => Number(candle.close || 0));

  if (recentCloses.length < 7 || currentOpen <= 0 || currentPrice <= 0) {
    return null;
  }

  const ma7 = sma(recentCloses, 7);
  const openAndPriceAboveMa7 = currentOpen > ma7 && currentPrice > ma7;
  const positiveFlip = detectStrictBullishDailyFlip(daily);

  if (!openAndPriceAboveMa7 && !positiveFlip) return null;

  let reason =
    '1D open-candle histogram flipped positive after prior closed candle was negative';
  if (openAndPriceAboveMa7 && positiveFlip) {
    reason = '1D open and current price above 7MA with positive hist flip';
  } else if (openAndPriceAboveMa7) {
    reason = '1D open and current price above 7MA';
  }

  return {
    symbol: ticker.symbol || null,
    dailyCandleTime: Number(latest?.open_time || 0) || null,
    currentOpen,
    currentPrice,
    ma7,
    openAndPriceAboveMa7,
    positiveFlip,
    reason
  };
}

function detectDailyRootSignal(daily = [], ticker = {}) {
  return evaluateDailyRootCriteria(daily, ticker);
}

async function evaluateSignal(symbol, candlesByTf = {}, ticker = {}) {
  const daily = Array.isArray(candlesByTf.D) ? candlesByTf.D : [];
  const rootCriteria = evaluateDailyRootCriteria(daily, { ...ticker, symbol });

  if (!rootCriteria) {
    lastMtfSnapshots.delete(symbol);
    return null;
  }

  const latestDailyCandle = daily[daily.length - 1];
  const {
    currentPrice,
    ma7,
    openAndPriceAboveMa7,
    positiveFlip,
    reason
  } = rootCriteria;

  const currentDailyHistogram = macdHistogram(daily, {
    useOpenForLastCandle: true
  });
  const dailyHistogramDirection =
    currentDailyHistogram > 0
      ? 'bullish'
      : currentDailyHistogram < 0
        ? 'negative'
        : 'neutral';

  const prevSnapshot = lastMtfSnapshots.get(symbol) || null;
  const mtf = evaluateMtfAlignment(
    {
      '5': candlesByTf['5'] || [],
      '15': candlesByTf['15'] || [],
      '60': candlesByTf['60'] || [],
      '240': candlesByTf['240'] || []
    },
    prevSnapshot
  );

  lastMtfSnapshots.set(symbol, {
    aligned: mtf.aligned,
    values: { ...mtf.values },
    candleTimes: { ...mtf.candleTimes }
  });

  let liquidity = {
    valid: false,
    reason: 'Live account equity unavailable'
  };

  try {
    const { totalEquityUsd } = await getAccountEquity();

    if (Number.isFinite(totalEquityUsd) && totalEquityUsd > 0) {
      const targetPositionUsd =
        (totalEquityUsd * liquidityConfig.riskPercentage) /
        liquidityConfig.stopLossPercentage;

      liquidity = checkLiquidity(
        {
          symbol,
          lastPrice: currentPrice,
          volume24hUsd: Number(ticker?.volume24hUsd || ticker?.turnover24h || 0),
          spreadPct: Number(ticker?.spreadPct || 0),
          topOfBookDepthUsd: Number(ticker?.topOfBookDepthUsd || 0)
        },
        targetPositionUsd
      );
    }
  } catch (error) {
    console.warn(
      `[signalManager] Equity/liquidity check skipped for ${symbol}: ${error.message}`
    );
  }

  const customRating = calculateCustomRating({
    macdFlip: positiveFlip,
    openAboveMa7: openAndPriceAboveMa7,
    mtfStatus: mtf.status,
    liquidityValid: liquidity.valid,
    marketTrend: mtf.aligned ? 'strong' : 'mixed',
    priceBelow14Ma: false
  });

  let tvRating = {
    available: false,
    score: null,
    percent: null,
    label: 'N/A'
  };

  try {
    tvRating = await getTradingViewRating(symbol);
  } catch (error) {
    console.warn(
      `[signalManager] TradingView rating lookup skipped for ${symbol}: ${error.message}`
    );
  }

  const numericTvScore = Number(tvRating?.score);
  const numericTvPercent = Number(tvRating?.percent);
  const tvAvailable =
    tvRating?.available === true && Number.isFinite(numericTvScore);

  const previousState = await getMtfState(symbol, 'D');
  const decision = mtf.aligned && liquidity.valid ? 'accept' : 'monitor';

  const dailyRootTriggered = positiveFlip || openAndPriceAboveMa7;
  const dailyFlipLabel = positiveFlip ? '1D' : '1D (7MA)';

  const latestFlippedTf =
    mtf.latestFlippedBullishTimeframe ||
    (dailyRootTriggered ? dailyFlipLabel : null);
  const latestFlipTime =
    mtf.latestFlipCandleTime ||
    (dailyRootTriggered ? Number(latestDailyCandle?.open_time || 0) || null : null);

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

    tvScore: tvAvailable ? numericTvScore : null,
    tvScorePercent:
      tvAvailable && Number.isFinite(numericTvPercent) ? numericTvPercent : null,
    tvScoreLabel: tvAvailable ? tvRating.label || 'unrated' : 'N/A',
    tvScoreAvailable: tvAvailable,

    mtfStatus: mtf.status,
    mtfValues: mtf.values,
    mtfPreviousValues: mtf.previousValues,
    mtfHistogramValues: mtf.histogramValues,
    mtfPreviousHistogramValues: mtf.previousHistogramValues,
    mtfAligned: mtf.aligned,
    mtfAlignmentFlip: mtf.alignmentFlip,
    mtfFlippedBullish: mtf.flippedBullish,
    latestFlippedBullishTimeframe: latestFlippedTf,
    mtfLatestFlippedBullish: latestFlippedTf,
    mtfLatestFlipCandleTime: latestFlipTime,

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

  return signal;
}

module.exports = {
  evaluateSignal,
  detectDailyRootSignal
};
