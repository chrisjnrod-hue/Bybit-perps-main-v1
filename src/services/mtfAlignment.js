const { macdHistogram } = require('./macd');

const REQUIRED_MTF_TFS = ['5', '15', '60', '240'];

function histogramDirection(candles) {
  if (!Array.isArray(candles) || candles.length < 26) {
    return 'neutral';
  }

  const value = macdHistogram(candles);

  if (value > 0) return 'bullish';
  if (value < 0) return 'negative';
  return 'neutral';
}

function evaluateMtfAlignment(candlesByTf = {}) {
  const values = {};

  for (const tf of REQUIRED_MTF_TFS) {
    values[tf] = histogramDirection(candlesByTf[tf] || []);
  }

  const bullishCount = REQUIRED_MTF_TFS.filter((tf) => values[tf] === 'bullish').length;
  const negativeCount = REQUIRED_MTF_TFS.filter((tf) => values[tf] === 'negative').length;
  const neutralCount = REQUIRED_MTF_TFS.filter((tf) => values[tf] === 'neutral').length;

  const aligned = bullishCount === REQUIRED_MTF_TFS.length;

  let status = 'mixed';
  if (aligned) status = 'bullish';
  else if (negativeCount === REQUIRED_MTF_TFS.length) status = 'negative';
  else if (neutralCount === REQUIRED_MTF_TFS.length) status = 'neutral';

  return {
    status,
    values,
    aligned,
    bullish: bullishCount,
    negative: negativeCount,
    neutral: neutralCount
  };
}

module.exports = {
  evaluateMtfAlignment,
  REQUIRED_MTF_TFS
};
