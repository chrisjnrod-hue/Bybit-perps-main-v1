function sma(values, period) {
  if (!Array.isArray(values) || !values.length) return 0;

  const slice = values.slice(-period);
  if (!slice.length) return 0;

  const total = slice.reduce((sum, value) => sum + Number(value || 0), 0);
  return total / slice.length;
}

function currentPriceAboveMA(candles, period = 7) {
  if (!Array.isArray(candles) || candles.length < period) return false;

  const closes = candles.map((candle) => Number(candle.close ?? candle.open ?? 0));
  const currentPrice = Number(candles[candles.length - 1]?.close ?? candles[candles.length - 1]?.open ?? 0);
  const ma = sma(closes, period);

  return currentPrice > ma;
}

function currentOpenAboveMA(candles, period = 7) {
  if (!Array.isArray(candles) || candles.length < period) return false;

  const closes = candles.map((candle) => Number(candle.close || 0));
  const latest = candles[candles.length - 1];
  const open = Number(latest?.open || 0);
  const ma = sma(closes, period);

  return open > ma;
}

module.exports = {
  sma,
  currentPriceAboveMA,
  currentOpenAboveMA
};
