function getLowerLow(candles, lookback = 3) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const slice = candles.slice(-lookback);
  const lows = slice.map((c) => Number(c.low || 0));
  return lows.length ? Math.min(...lows) : null;
}

function get14Ma(candles) {
  if (!Array.isArray(candles) || candles.length < 14) return null;
  const closes = candles.slice(-14).map((c) => Number(c.close || 0));
  const sum = closes.reduce((acc, v) => acc + v, 0);
  return sum / closes.length;
}

function evaluateTrailingStop({
  symbol,
  side = 'long',
  entryPrice,
  stopLoss,
  currentPrice,
  candles = [],
  trailingLookback = 3,
  hardMaPeriod = 14
}) {
  const price = Number(currentPrice || 0);
  if (!price || !entryPrice) {
    return {
      stopLoss: stopLoss,
      shouldExit: false,
      reason: 'missing_market_data'
    };
  }

  const lowerLow = getLowerLow(candles, trailingLookback);
  const ma14 = get14Ma(candles);

  let nextStop = Number(stopLoss || entryPrice);

  if (side === 'long') {
    const higherLowTrigger = lowerLow ? Number(lowerLow) : Number(entryPrice);
    const potentialTrailing = higherLowTrigger * 0.998;

    if (currentPrice > entryPrice && potentialTrailing > nextStop) {
      nextStop = potentialTrailing;
    }

    if (ma14 && price < ma14) {
      return {
        stopLoss: ma14,
        shouldExit: true,
        reason: 'close_below_14ma'
      };
    }
  }

  if (side === 'short') {
    const higherHigh = candles.length
      ? Math.max(...candles.slice(-trailingLookback).map((c) => Number(c.high || 0)))
      : entryPrice;
    const potentialTrailing = higherHigh * 1.002;

    if (currentPrice < entryPrice && potentialTrailing < nextStop) {
      nextStop = potentialTrailing;
    }

    if (ma14 && price > ma14) {
      return {
        stopLoss: ma14,
        shouldExit: true,
        reason: 'close_above_14ma'
      };
    }
  }

  return {
    stopLoss: nextStop,
    shouldExit: false,
    reason: 'trail'
  };
}

module.exports = {
  getLowerLow,
  get14Ma,
  evaluateTrailingStop
};
