function sma(values, period) {
  if (!Array.isArray(values) || !values.length) return 0;
  const slice = values.slice(-period);
  const total = slice.reduce((sum, value) => sum + Number(value || 0), 0);
  return total / Math.max(slice.length, 1);
}

function currentOpenAboveMA(candles, period = 7) {
  if (!Array.isArray(candles) || candles.length < period) return false;
  const closes = candles.map((c) => Number(c.close || 0));
  const latestOpen = Number(candles[candles.length - 1].open || 0);
  const ma = sma(closes, period);
  return latestOpen > ma;
}

module.exports = {
  sma,
  currentOpenAboveMA
};