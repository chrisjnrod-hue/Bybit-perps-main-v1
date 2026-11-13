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

function getHistogram(candles) {
  if (!Array.isArray(candles) || candles.length < 26) {
    return null;
  }

  const value = Number(macdHistogram(candles));
  return Number.isFinite(value) ? value : null;
}

function getLastCandleTime(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const time = Number(last?.open_time ?? last?.start ?? last?.t ?? last?.timestamp ?? 0);
  return Number.isFinite(time) && time > 0 ? time : null;
}

function evaluateMtfAlignment(candlesByTf = {}) {
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

    const currentHistogram = getHistogram(candles);

    // compare current live candle against the last closed candle
    const previousHistogram = candles.length >= 27
      ? getHistogram(candles.slice(0, -1))
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

    if (
      previousHistogram !== null &&
      previousHistogram < 0 &&
      currentHistogram !== null &&
      currentHistogram > 0
    ) {
      flippedBullish.push(timeframe);
      flipCandleTimes[timeframe] = getLastCandleTime(candles);
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

  const latestFlippedBullish = flippedBullish
    .map((timeframe) => ({
      timeframe,
      candleTime: flipCandleTimes[timeframe]
    }))
    .sort((a, b) => {
      if (a.candleTime === null && b.candleTime === null) return 0;
      if (a.candleTime === null) return 1;
      if (b.candleTime === null) return -1;
      return b.candleTime - a.candleTime;
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
