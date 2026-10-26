function ema(values, period) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const k = 2 / (period + 1);
  let result = Number(values[0]);
  for (let i = 1; i < values.length; i++) {
    result = Number(values[i]) * k + result * (1 - k);
  }
  return result;
}

function macdHistogram(candles, fast = 12, slow = 26, signal = 9) {
  const closes = candles.map((c) => Number(c.close || 0));
  if (closes.length < slow) return 0;

  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macd = fastEma - slowEma;
  const signalLine = macd * (2 / (signal + 1));
  return macd - signalLine;
}

function detectBullishHistogramFlip(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return false;

  const hist = [];
  for (let i = 0; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    hist.push(macdHistogram(window));
  }

  if (hist.length < 2) return false;
  const prev = hist[hist.length - 2];
  const curr = hist[hist.length - 1];
  return prev <= 0 && curr > 0;
}

module.exports = {
  ema,
  macdHistogram,
  detectBullishHistogramFlip
};