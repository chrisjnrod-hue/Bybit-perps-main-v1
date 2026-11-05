function ema(values, period) {
  if (!Array.isArray(values) || values.length === 0) return 0;

  const k = 2 / (period + 1);
  let result = Number(values[0]);

  for (let i = 1; i < values.length; i++) {
    result = Number(values[i]) * k + result * (1 - k);
  }

  return result;
}

function macdSeries(candles) {
  const closes = candles.map((c) => Number(c.close || 0));
  if (closes.length < 26) {
    return { macd: [], signalLine: [], histogram: [] };
  }

  const fastEma = [];
  const slowEma = [];
  const fastK = 2 / (12 + 1);
  const slowK = 2 / (26 + 1);

  let fastPrev = null;
  let slowPrev = null;

  for (const close of closes) {
    if (fastPrev === null) {
      fastPrev = close;
    } else {
      fastPrev = close * fastK + fastPrev * (1 - fastK);
    }
    fastEma.push(fastPrev);

    if (slowPrev === null) {
      slowPrev = close;
    } else {
      slowPrev = close * slowK + slowPrev * (1 - slowK);
    }
    slowEma.push(slowPrev);
  }

  const macd = fastEma.map((value, i) => value - slowEma[i]);

  const signalLine = [];
  const signalK = 2 / (9 + 1);
  let prevSignal = macd[0];

  for (const value of macd) {
    prevSignal = value * signalK + prevSignal * (1 - signalK);
    signalLine.push(prevSignal);
  }

  const histogram = macd.map((value, i) => value - signalLine[i]);

  return { macd, signalLine, histogram };
}

function macdHistogram(candles) {
  const { histogram } = macdSeries(candles);
  return histogram.length ? histogram[histogram.length - 1] : 0;
}

function detectBullishHistogramFlip(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return false;

  const { histogram } = macdSeries(candles);
  if (histogram.length < 2) return false;

  const prev = histogram[histogram.length - 2];
  const curr = histogram[histogram.length - 1];

  return prev <= 0 && curr > 0;
}

module.exports = {
  ema,
  macdSeries,
  macdHistogram,
  detectBullishHistogramFlip
};
