const config = require('../config');

function getAccountEquityUsd() {
  return Number(config.DEFAULT_ACCOUNT_EQUITY_USD || 10000);
}

function getTargetPositionUsd() {
  return getAccountEquityUsd() * Number(config.TARGET_POSITION_FRAC || 0.01);
}

function shouldOpenTrade(signal, symbolInfo = {}) {
  if (!signal) return { open: false, reason: 'missing_signal' };
  if (signal.customScore < 65) return { open: false, reason: 'score_low' };
  if (signal.mtfStatus === 'negative') return { open: false, reason: 'mtf_negative' };
  if (signal.mtfStatus === 'mixed') return { open: false, reason: 'mtf_mixed' };

  const volume24h = Number(symbolInfo.volume24hUsd || 0);
  const spreadPct = Number(symbolInfo.spreadPct || 0);
  const depth = Number(symbolInfo.topOfBookDepthUsd || 0);
  const target = getTargetPositionUsd();

  if (spreadPct > Number(config.SPREAD_PERCENT || 0.05)) {
    return { open: false, reason: 'spread_too_high' };
  }

  if (volume24h < target * 2) {
    return { open: false, reason: 'insufficient_24h_volume' };
  }

  if (depth < target) {
    return { open: false, reason: 'insufficient_depth' };
  }

  return { open: true, reason: 'all_checks_passed' };
}

function buildTradePlan(signal, symbolInfo = {}) {
  const price = Number(signal.price || 0);
  const qty = getTargetPositionUsd() / Math.max(price, 0.000001);

  return {
    symbol: signal.symbol,
    side: 'long',
    price,
    qty,
    stopLoss: price * (1 - (Number(config.DEFAULT_SL_PERCENT || 1.5) / 100)),
    takeProfit: price * (1 + (Number(config.DEFAULT_TP_PERCENT || 3) / 100)),
    trailingStop: 'higher_lows or close below 14MA',
    maxOpenTrades: Number(config.MAX_OPEN_TRADES || 3)
  };
}

module.exports = {
  getAccountEquityUsd,
  getTargetPositionUsd,
  shouldOpenTrade,
  buildTradePlan
};