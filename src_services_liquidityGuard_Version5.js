function checkLiquidity(symbolInfo = {}, accountEquityUsd = 10000, targetPositionFrac = 0.01) {
  const volume24hUsd = Number(symbolInfo.volume24hUsd || 0);
  const spreadPct = Number(symbolInfo.spreadPct || 0);
  const topOfBookDepthUsd = Number(symbolInfo.topOfBookDepthUsd || 0);
  const targetUsd = Number(accountEquityUsd || 0) * Number(targetPositionFrac || 0.01);

  if (spreadPct > 0.12) {
    return { valid: false, reason: 'spread_too_high' };
  }

  if (volume24hUsd < targetUsd * 2) {
    return { valid: false, reason: 'insufficient_24h_volume' };
  }

  if (topOfBookDepthUsd < targetUsd) {
    return { valid: false, reason: 'insufficient_depth' };
  }

  return { valid: true, reason: 'liquid' };
}

module.exports = {
  checkLiquidity
};