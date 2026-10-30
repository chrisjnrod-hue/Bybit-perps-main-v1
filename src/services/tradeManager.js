const config = require('../config');

function shouldOpenTrade(signal, market) {
  const volume24hUsd = Number(market?.volume24hUsd || 0);
  const spreadPct = Number(market?.spreadPct || 0.02);
  const topOfBookDepthUsd = Number(market?.topOfBookDepthUsd || 0);

  if (!signal || signal.decision !== 'accept') return { open: false, reason: 'signal not accepted' };

  if (volume24hUsd <= 0) return { open: false, reason: 'no volume' };
  if (spreadPct > 0.2) return { open: false, reason: 'spread too high' };
  if (topOfBookDepthUsd <= 0) return { open: false, reason: 'depth too low' };

  return { open: true, reason: 'meets risk requirements' };
}

function buildTradePlan(signal, market) {
  const price = Number(signal.price || 0);
  const spreadPct = Number(market?.spreadPct || 0.02);

  const stopLoss = price * (Number(config.DEFAULT_SL_PERCENT || 1.5) / 100);
  const takeProfit = price * (Number(config.DEFAULT_TP_PERCENT || 3) / 100);

  return {
    symbol: signal.symbol,
    side: 'long',
    price,
    stopLoss: Number(stopLoss.toFixed(8)),
    takeProfit: Number(takeProfit.toFixed(8)),
    spreadPct,
    volume24hUsd: Number(market?.volume24hUsd || 0),
    topOfBookDepthUsd: Number(market?.topOfBookDepthUsd || 0)
  };
}

module.exports = {
  shouldOpenTrade,
  buildTradePlan
};
