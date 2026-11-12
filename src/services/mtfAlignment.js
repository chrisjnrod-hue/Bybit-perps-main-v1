const { macdHistogram } = require('./macd');

const REQUIRED_MTF_TFS = ['5', '15', '60', '240'];

function histogramDirection(candles) {
  if (!Array.isArray(candles) || candles.length < 26) {
    return 'neutral';
  }

  const histogram = Number(macdHistogram(candles));

  if (!Number.isFinite(histogram)) return 'neutral';
  if (histogram > 0) return 'bullish';
  if (histogram < 0) return 'negative';
  return 'neutral';
}

function evaluateMtfAlignment(candlesByTf = {}) {
  const values = {};
  const previousValues = {};
  const histogramValues = {};
  const previousHistogramValues = {};
  const flippedBullish = [];

  for (const timeframe of REQUIRED_MTF_TFS) {
    const candles = Array.isArray(candlesByTf[timeframe])
      ? candlesByTf[timeframe]
      : [];

    const currentHistogram = candles.length >= 26
      ? Number(macdHistogram(candles))
      : null;

    // The final candle is the currently forming candle. Excluding it lets us
    // compare its live histogram against the previous candle's closed value.
    const previousHistogram = candles.length >= 27
      ? Number(macdHistogram(candles.slice(0, -1)))
      : null;

    const currentDirection = currentHistogram === null
      ? 'neutral'
      : currentHistogram > 0
        ? 'bullish'
        : currentHistogram < 0
          ? 'negative'
          : 'neutral';

    const previousDirection = previousHistogram === null
      ? 'neutral'
      : previousHistogram > 0
        ? 'bullish'
        : previousHistogram < 0
          ? 'negative'
          : 'neutral';

    values[timeframe] = currentDirection;
    previousValues[timeframe] = previousDirection;
    histogramValues[timeframe] = currentHistogram;
    previousHistogramValues[timeframe] = previousHistogram;

    // The requested flip is negative on the previous candle and positive on
    // the currently forming candle.
    if (
      previousHistogram !== null &&
      previousHistogram < 0 &&
      currentHistogram !== null &&
      currentHistogram > 0
    ) {
      flippedBullish.push(timeframe);
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

  return {
    status,
    values,
    previousValues,
    histogramValues,
    previousHistogramValues,
    aligned,
    // This identifies a current-candle negative-to-positive flip. The alert
    // still requires every required timeframe to be bullish.
    alignmentFlip: aligned && flippedBullish.length > 0,
    flippedBullish,
    bullish: bullishCount,
    negative: negativeCount,
    neutral: neutralCount
  };
}

module.exports = {
  evaluateMtfAlignment,
  REQUIRED_MTF_TFS
};
