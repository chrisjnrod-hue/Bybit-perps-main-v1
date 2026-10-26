function formatSummaryTelegram(signals) {
  const list = [...new Set((signals || []).map((s) => String(s.symbol || '').toUpperCase()))].sort();

  return [
    `Valid 1D signals: ${list.length}`,
    'A-Z list:',
    ...list.map((symbol) => `${symbol}: 1`)
  ].join('\n');
}

function formatRecommendationTelegram(item) {
  return [
    `Recommended trade: ${item.symbol}`,
    `Action: ${item.action}`,
    `Custom Score: ${item.customScore}`,
    `TV Score: ${item.tvScore}`,
    `MTF: ${item.mtfStatus}`,
    `Liquidity: ${item.liquidity}`,
    `Reason: ${item.reason}`
  ].join('\n');
}

function formatSignalBlock(signal) {
  return [
    `Signal: ${signal.symbol}`,
    `Time: ${signal.time}`,
    `Decision: ${signal.decision}`,
    `Reason: ${signal.reason}`,
    `Custom score: ${signal.customScore}`,
    `TV score: ${signal.tvScore}`,
    `MTF status: ${signal.mtfStatus}`,
    `Price: ${signal.price}`,
    `Volume 24h: ${signal.volume24h}`,
    `Spread: ${signal.spreadPct}`,
    `Liquidity: ${signal.liquidity}`,
    `Stop: ${signal.trailingStop}`,
    `TP: ${signal.takeProfit}`,
    `Action: ${signal.action}`
  ].join('\n');
}

module.exports = {
  formatSummaryTelegram,
  formatRecommendationTelegram,
  formatSignalBlock
};
