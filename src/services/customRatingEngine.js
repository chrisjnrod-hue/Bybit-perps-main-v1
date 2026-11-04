function labelForScore(score) {
  if (score >= 80) return 'StrongBuy';
  if (score >= 65) return 'Buy';
  if (score >= 45) return 'Neutral';
  return 'Sell';
}

function calculateCustomRating(signal = {}) {
  const components = {
    macdFlip: signal.macdFlip ? 25 : 0,
    openAboveMa7: signal.openAboveMa7 ? 20 : 0,
    mtfStatus:
      signal.mtfStatus === 'bullish'
        ? 20
        : signal.mtfStatus === 'mixed'
          ? -15
          : signal.mtfStatus === 'negative'
            ? -25
            : 0,
    liquidity: signal.liquidityValid ? 15 : -20,
    marketTrend: signal.marketTrend === 'strong' ? 10 : 0,
    priceBelow14Ma: signal.priceBelow14Ma ? -20 : 0
  };

  const rawScore = Object.values(components).reduce((total, value) => total + value, 0);
  const score = Math.max(0, Math.min(100, rawScore));

  return {
    score,
    label: labelForScore(score),
    components
  };
}

module.exports = {
  calculateCustomRating
};
