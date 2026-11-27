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

function getLastCandle(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  return candles[candles.length - 1];
}

function getLastCandleTime(candles) {
  const last = getLastCandle(candles);
  if (!last) return null;

  return normalizeEpochMs(
    last.open_time ??
    last.start ??
    last.t ??
    last.timestamp
  );
}

function getLastCandleOpen(candles) {
  const last = getLastCandle(candles);
  if (!last) return null;

  const open = Number(last.open ?? 0);
  return Number.isFinite(open) && open > 0 ? open : null;
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
  const activeOpenPrices = {};
  const flippedBullish = [];
  const flipCandleTimes = {};
  const flipOpenPrices = {};

  for (const timeframe of REQUIRED_MTF_TFS) {
    const candles = Array.isArray(candlesByTf[timeframe])
      ? candlesByTf[timeframe]
      : [];

    const currentHistogram = getHistogram(candles, {
      useOpenForLastCandle: true
    });

    const previousHistogram =
      candles.length >= 27
        ? getHistogram(candles.slice(0, -1), {
            useOpenForLastCandle: false
          })
        : null;

    const currentDirection = directionFromHistogram(currentHistogram);
    const previousDirection = directionFromHistogram(previousHistogram);
    const lastCandleTime = getLastCandleTime(candles);
    const activeOpenPrice = getLastCandleOpen(candles);

    values[timeframe] = currentDirection;
    previousValues[timeframe] = previousDirection;
    histogramValues[timeframe] = currentHistogram;
    previousHistogramValues[timeframe] = previousHistogram;
    candleTimes[timeframe] = lastCandleTime;
    activeOpenPrices[timeframe] = activeOpenPrice;

    const candleLevelFlip =
      previousHistogram !== null &&
      previousHistogram < 0 &&
      currentHistogram !== null &&
      currentHistogram > 0;

    if (candleLevelFlip) {
      flippedBullish.push(timeframe);
      flipCandleTimes[timeframe] = lastCandleTime;
      flipOpenPrices[timeframe] = activeOpenPrice;
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

  const aligned =
    bullishCount === REQUIRED_MTF_TFS.length;

  const wasPreviouslyAligned =
    previousSnapshot?.aligned === true;

  let status = 'mixed';

  if (aligned) {
    status = 'bullish';
  } else if (negativeCount === REQUIRED_MTF_TFS.length) {
    status = 'negative';
  } else if (neutralCount === REQUIRED_MTF_TFS.length) {
    status = 'neutral';
  }

  const latestFlippedBullish =
    flippedBullish
      .map((timeframe) => ({
        timeframe,
        candleTime: flipCandleTimes[timeframe],
        openPrice: flipOpenPrices[timeframe]
      }))
      .sort((a, b) => {
        if ((b.candleTime || 0) !== (a.candleTime || 0)) {
          return (b.candleTime || 0) - (a.candleTime || 0);
        }

        return (
          (TF_ORDER[b.timeframe] || 0) -
          (TF_ORDER[a.timeframe] || 0)
        );
      })[0] || null;

  const alignmentFlip =
    aligned &&
    !wasPreviouslyAligned &&
    latestFlippedBullish !== null;

  return {
    status,
    values,
    previousValues,
    histogramValues,
    previousHistogramValues,
    candleTimes,
    activeOpenPrices,
    aligned,
    alignmentFlip,
    flippedBullish,
    flipCandleTimes,
    flipOpenPrices,
    latestFlippedBullishTimeframe:
      latestFlippedBullish?.timeframe || null,
    latestFlipCandleTime:
      latestFlippedBullish?.candleTime || null,
    latestFlipOpenPrice:
      latestFlippedBullish?.openPrice || null,
    bullish: bullishCount,
    negative: negativeCount,
    neutral: neutralCount
  };
}

module.exports = {
  evaluateMtfAlignment,
  REQUIRED_MTF_TFS
};
