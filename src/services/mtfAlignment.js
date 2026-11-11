const { macdHistogram } = require('./macd');

const REQUIRED_MTF_TFS = ['5', '15', '60', '240'];

function histogramDirection(candles) {
  if (!Array.isArray(candles) || candles.length < 26) {
    return 'neutral';
  }

  const value = Number(macdHistogram(candles));

  if (!Number.isFinite(value)) return 'neutral';
  if (value > 0) return 'bullish';
  if (value < 0) return 'negative';
  return 'neutral';
}

function evaluateMtfAlignment(candlesByTf = {}) {
  const values = {};
  const previousValues = {};
  const flippedBullish = [];

  for (const tf of REQUIRED_MTF_TFS) {
    const candles = Array.isArray(candlesByTf[tf])
      ? candlesByTf[tf]
      : [];

    const currentDirection = histogramDirection(candles);

    // Exclude the current, forming candle to get the previous candle's
    // histogram direction.
    const previousDirection = candles.length > 1
      ? histogramDirection(candles.slice(0, -1))
      : 'neutral';

    values[tf] = currentDirection;
    previousValues[tf] = previousDirection;

    if (
      currentDirection === 'bullish' &&
      previousDirection === 'negative'
    ) {
      flippedBullish.push(tf);
    }
  }

  const bullishCount = REQUIRED_MTF_TFS.filter(
    (tf) => values[tf] === 'bullish'
  ).length;

  const negativeCount = REQUIRED_MTF_TFS.filter(
    (tf) => values[tf] === 'negative'
  ).length;

  const neutralCount = REQUIRED_MTF_TFS.filter(
    (tf) => values[tf] === 'neutral'
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
    aligned,
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
