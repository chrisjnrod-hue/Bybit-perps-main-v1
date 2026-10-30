const { currentOpenAboveMA } = require('./ma');
const { detectBullishHistogramFlip } = require('./macd');

function evaluateMtfAlignment(candlesByTf = {}) {
  const result = {};
  let bullish = 0;
  let negative = 0;

  for (const [tf, candles] of Object.entries(candlesByTf)) {
    if (!Array.isArray(candles) || candles.length < 2) {
      result[tf] = 'neutral';
      continue;
    }

    const flip = detectBullishHistogramFlip(candles);
    const aboveMa = currentOpenAboveMA(candles, 7);

    if (flip || aboveMa) {
      result[tf] = 'bullish';
      bullish += 1;
    } else {
      result[tf] = 'negative';
      negative += 1;
    }
  }

  const total = Object.keys(result).length || 1;
  const positiveRatio = bullish / total;

  let status = 'neutral';

  if (bullish >= Math.max(3, Math.ceil(total * 0.6)) && negative === 0) {
    status = 'bullish';
  } else if (negative >= Math.max(2, Math.ceil(total * 0.4)) && bullish === 0) {
    status = 'negative';
  } else if (bullish > 0 && negative > 0) {
    status = 'mixed';
  }

  return {
    status,
    ratio: positiveRatio,
    values: result,
    bullish,
    negative,
    aligned: status === 'bullish'
  };
}

module.exports = {
  evaluateMtfAlignment
};
