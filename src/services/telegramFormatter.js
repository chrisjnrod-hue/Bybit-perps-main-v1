function formatTimeframe(tf) {
  const labels = {
    '5': '5m',
    '15': '15m',
    '60': '1h',
    '240': '4h',
    D: '1D'
  };

  return labels[String(tf)] || `${tf}m`;
}

function formatMtfValues(mtfValues = {}) {
  return Object.entries(mtfValues)
    .map(([tf, status]) => {
      const mark = status === 'bullish' ? '✓' : status === 'neutral' ? '–' : '✗';
      return `${formatTimeframe(tf)}: ${mark}`;
    })
    .join(' | ');
}

function formatSummaryTelegram(signals) {
  const list = [
    ...new Set((signals || []).map((signal) => String(signal.symbol || '').toUpperCase()))
  ].sort();

  return [
    `Valid 1D signals: ${list.length}`,
    'A-Z list:',
    ...list.map((symbol) => `${symbol}: 1`)
  ].join('\n');
}

function formatMtfAlignmentAlert(signal) {
  const tfString = formatMtfValues(signal.mtfValues || {});

  return [
    `MTF Alignment Alert: ${signal.symbol}`,
    `Time: ${signal.time || new Date().toISOString()}`,
    `1D Trigger: ${signal.reason || 'n/a'}`,
    `Decision: ${signal.decision || 'monitor'}`,
    `Custom score: ${signal.customScore ?? 'N/A'}`,
    `TV score: ${signal.tvScore ?? 'N/A'}`,
    `MTF status: ${signal.mtfStatus || 'neutral'} [${tfString}]`,
    `Price: ${signal.price ?? 'N/A'}`,
    `Volume 24h: ${signal.volume24h ?? 'N/A'}`,
    `Spread: ${signal.spreadPct ?? 'N/A'}`,
    `Liquidity: ${signal.liquidity ?? 'N/A'}`,
    `Stop: ${signal.trailingStop || 'higher_lows or close below 14MA'}`,
    `TP: ${signal.takeProfit || '3%'}`,
    `Action: ${signal.action || (signal.decision === 'accept' ? 'open' : 'monitor')}`
  ].join('\n');
}

function formatRecommendationTelegram(item) {
  const tfString = formatMtfValues(item.mtfValues || {});

  return [
    `Recommended Trade: ${item.symbol}`,
    `Action: ${item.action}`,
    `Custom Score: ${item.customScore}`,
    `TV Score: ${item.tvScore}`,
    `MTF Status: ${item.mtfStatus} [${tfString}]`,
    `Liquidity: ${item.liquidity}`,
    `Reason: ${item.reason}`
  ].join('\n');
}

module.exports = {
  formatSummaryTelegram,
  formatMtfAlignmentAlert,
  formatRecommendationTelegram
};
