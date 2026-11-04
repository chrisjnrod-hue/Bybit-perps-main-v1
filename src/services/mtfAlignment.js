const { macdHistogram } = require('./macd');

const REQUIRED_MTF_TFS = ['5', '15', '60', '240'];

function histogramDirection(candles) {
  if (!Array.isArray(candles) || candles.length < 26) {
    return 'neutral';
  }

  const histogram = macdHistogram(candles);

  if (histogram > 0) return 'bullish';
  if (histogram < 0) return 'negative';
  return 'neutral';
}

function evaluateMtfAlignment(candlesByTf = {}, dailyHistogramDirection = 'neutral') {
  const values = {};
  let bullish = 0;
  let negative = 0;
  let neutral = 0;

  for (const tf of REQUIRED_MTF_TFS) {
    const direction = histogramDirection(candlesByTf[tf] || []);
    values[tf] = direction;

    if (direction === 'bullish') bullish += 1;
    else if (direction === 'negative') negative += 1;
    else neutral += 1;
  }

  let status = 'neutral';

  if (bullish === REQUIRED_MTF_TFS.length) {
    status = 'bullish';
  } else if (negative === REQUIRED_MTF_TFS.length) {
    status = 'negative';
  } else if (bullish > 0 || negative > 0) {
    status = 'mixed';
  }

  const alignedWithDaily =
    dailyHistogramDirection !== 'neutral' &&
    REQUIRED_MTF_TFS.every((tf) => values[tf] === dailyHistogramDirection);

  return {
    status,
    values,
    bullish,
    negative,
    neutral,
    dailyHistogramDirection,
    aligned: alignedWithDaily,
    alignedWithDaily: alignedWithDaily
  };
}

module.exports = {
  evaluateMtfAlignment,
  REQUIRED_MTF_TFS
};
