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
      const mark = status === 'bullish'
        ? '✓'
        : status === 'neutral'
          ? '–'
          : '✗';

      return `${formatTimeframe(tf)}: ${mark}`;
    })
    .join(' | ');
}

function formatSummaryTelegram(signals) {
  const symbols = [
    ...new Set(
      (signals || [])
        .map((signal) => String(signal?.symbol || '').trim().toUpperCase())
        .filter(Boolean)
    )
  ].sort();

  return [
    `Valid 1D signals: ${symbols.length}`,
    'A-Z list:',
    ...symbols.map((symbol) => `${symbol}: 1`)
  ].join('\n');
}

function formatSummaryTelegramChunks(signals, maxLength = 3500) {
  const symbols = [
    ...new Set(
      (signals || [])
        .map((signal) => String(signal?.symbol || '').trim().toUpperCase())
        .filter(Boolean)
    )
  ].sort();

  const header = `Valid 1D signals: ${symbols.length}\nA-Z list:`;
  const chunks = [];
  let lines = [];
  let currentLength = header.length;

  for (const symbol of symbols) {
    const line = `${symbol}: 1`;

    if (lines.length && currentLength + line.length + 1 > maxLength) {
      chunks.push(`${header}\n${lines.join('\n')}`);
      lines = [];
      currentLength = header.length;
    }

    lines.push(line);
    currentLength += line.length + 1;
  }

  if (lines.length || chunks.length === 0) {
    chunks.push(`${header}\n${lines.join('\n')}`);
  }

  return chunks;
}

function formatTvRating(signal) {
  if (signal?.tvScoreAvailable !== true || !Number.isFinite(Number(signal.tvScore))) {
    return 'N/A (unavailable)';
  }

  const raw = Number(signal.tvScore).toFixed(2);
  const percent = Number.isFinite(Number(signal.tvScorePercent))
    ? `, ${Number(signal.tvScorePercent).toFixed(1)}%`
    : '';

  return `${raw} / 1${percent} (${signal.tvScoreLabel || 'unrated'})`;
}

function formatMtfAlignmentAlert(signal) {
  const tfString = formatMtfValues(signal.mtfValues || {});
  const latestFlipTf =
    signal?.latestFlippedBullishTimeframe ||
    signal?.mtfLatestFlippedBullish ||
    'none';

  return [
    `MTF Alignment Alert: ${signal.symbol}`,
    `Time: ${signal.time || new Date().toISOString()}`,
    `1D Trigger: ${signal.reason || 'n/a'}`,
    `Decision: ${signal.decision || 'monitor'}`,
    `Latest bullish TF flip: ${latestFlipTf}`,
    `TradingView technical rating: ${formatTvRating(signal)}`,
    `Custom score: ${signal.customScore ?? 'N/A'} (${signal.customScoreLabel || 'unrated'})`,
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
  const tvRating = item.tvScoreAvailable === true && Number.isFinite(Number(item.tvScore))
    ? `${Number(item.tvScore).toFixed(2)} / 1 (${item.tvScoreLabel || 'unrated'})`
    : 'N/A (unavailable)';

  return [
    `Recommended Trade: ${item.symbol}`,
    `Action: ${item.action}`,
    `TradingView technical rating: ${tvRating}`,
    `Custom score: ${item.customScore} (${item.customScoreLabel || 'unrated'})`,
    `MTF Status: ${item.mtfStatus} [${tfString}]`,
    `Liquidity: ${item.liquidity}`,
    `Reason: ${item.reason}`
  ].join('\n');
}

module.exports = {
  formatSummaryTelegram,
  formatSummaryTelegramChunks,
  formatMtfAlignmentAlert,
  formatRecommendationTelegram
};
