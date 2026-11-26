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
