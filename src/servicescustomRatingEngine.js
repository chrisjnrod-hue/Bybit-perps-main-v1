function calculateCustomRating(signal) {
  let score = 0;
  if (signal.macdFlip) score += 25;
  if (signal.openAboveMa7) score += 20;
  if (signal.mtfStatus === 'bullish') score += 20;
  if (signal.mtfStatus === 'mixed') score -= 15;
  if (signal.mtfStatus === 'negative') score -= 25;
  if (signal.liquidityValid) score += 15;
  else score -= 20;
  if (signal.marketTrend === 'strong') score += 10;
  if (signal.priceBelow14Ma) score -= 20;

  score = Math.max(0, Math.min(100, score));

  let label = 'Sell';
  if (score >= 80) label = 'StrongBuy';
  else if (score >= 65) label = 'Buy';
  else if (score >= 45) label = 'Neutral';

  return {
    score,
    label
  };
}

module.exports = {
  calculateCustomRating
};
