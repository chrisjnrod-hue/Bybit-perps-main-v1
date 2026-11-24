const { macdHistogram } = require('./macd');

const REQUIRED_MTF_TFS = ['5', '15', '60', '240'];
const TF_MS = {
  '5': 5 * 60 * 1000,
  '15': 15 * 60 * 1000,
  '60': 60 * 60 * 1000,
  '240': 4 * 60 * 60 * 1000
};
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

function isCurrentOpenCandle(candleOpenTime, timeframe, nowMs = Date.now()) {
  const intervalMs = TF_MS[String(timeframe)];
  if (!intervalMs || !Number.isFinite(candleOpenTime) || candleOpenTime <= 0) {
    return false;
  }
  const currentBucketStart = Math.floor(nowMs / intervalMs) * intervalMs;
  return candleOpenTime === currentBucketStart;
}

function directionFromHistogram(histogram) {
  if (histogram === null) return 'neutral';
  if (histogram > 0) return 'bullish';
  if (histogram < 0) return 'negative';
  return 'neutral';
}

function evaluateMtfAlignment(candlesByTf = {}, nowMs = Date.now()) {
  const values = {};
  const previousValues = {};
  const histogramValues = {};
  const previousHistogramValues = {};
  const flippedBullish = [];
  const flipCandleTimes = {};

  for (const timeframe of REQUIRED_MTF_TFS) {
    const candles = Array.isArray(candlesByTf[timeframe])
      ? candlesByTf[timeframe]
      : [];

    // Evaluate active open candle strictly at its open price; prior candle at closed price
    const currentHistogram = getHistogram(candles, {
      useOpenForLastCandle: true
    });
    const previousHistogram =
      candles.length >= 27
        ? getHistogram(candles.slice(0, -1), { useOpenForLastCandle: false })
        : null;

    const currentDirection = directionFromHistogram(currentHistogram);
    const previousDirection = directionFromHistogram(previousHistogram);

    values[timeframe] = currentDirection;
    previousValues[timeframe] = previousDirection;
    histogramValues[timeframe] = currentHistogram;
    previousHistogramValues[timeframe] = previousHistogram;

    const lastCandleTime = getLastCandleTime(candles);

    // Strict rule:
    // 1. Previous closed candle histogram strictly negative (< 0, closed red)
    // 2. Current open candle histogram at open price strictly positive (> 0)
    // 3. The flip candle is the currently active open candle for that timeframe
    if (
      previousHistogram !== null &&
      previousHistogram < 0 &&
      currentHistogram !== null &&
      currentHistogram > 0 &&
      isCurrentOpenCandle(lastCandleTime, timeframe, nowMs)
    ) {
      flippedBullish.push(timeframe);
      flipCandleTimes[timeframe] = lastCandleTime;
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

  // All 4 MTF timeframes must have strictly positive MACD histogram
  const aligned = bullishCount === REQUIRED_MTF_TFS.length;

  let status = 'mixed';
  if (aligned) status = 'bullish';
  else if (negativeCount === REQUIRED_MTF_TFS.length) status = 'negative';
  else if (neutralCount === REQUIRED_MTF_TFS.length) status = 'neutral';

  const latestFlippedBullish =
    flippedBullish
      .map((timeframe) => ({
        timeframe,
        candleTime: flipCandleTimes[timeframe]
      }))
      .sort((a, b) => {
        if (a.candleTime === null && b.candleTime === null) {
          return (TF_ORDER[b.timeframe] || 0) - (TF_ORDER[a.timeframe] || 0);
        }
        if (a.candleTime === null) return 1;
        if (b.candleTime === null) return -1;
        if (b.candleTime !== a.candleTime) {
          return b.candleTime - a.candleTime;
        }
        return (TF_ORDER[b.timeframe] || 0) - (TF_ORDER[a.timeframe] || 0);
      })[0] || null;

  return {
    status,
    values,
    previousValues,
    histogramValues,
    previousHistogramValues,
    aligned,
    alignmentFlip: aligned && latestFlippedBullish !== null,
    flippedBullish,
    flipCandleTimes,
    latestFlippedBullishTimeframe: latestFlippedBullish?.timeframe || null,
    latestFlipCandleTime: latestFlippedBullish?.candleTime || null,
    bullish: bullishCount,
    negative: negativeCount,
    neutral: neutralCount
  };
}

module.exports = {
  evaluateMtfAlignment,
  REQUIRED_MTF_TFS
};
