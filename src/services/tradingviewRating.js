const axios = require('axios');
const config = require('../config');

function labelForScore(score) {
  if (score >= 80) return 'StrongBuy';
  if (score >= 65) return 'Buy';
  if (score >= 45) return 'Neutral';
  return 'Sell';
}

function isEnabled(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

function parseTvScore(payload) {
  if (!payload) return null;

  const candidates = [
    payload?.score,
    payload?.rating,
    payload?.value,
    payload?.data?.score,
    payload?.data?.rating,
    payload?.data?.value,
    payload?.result?.score,
    payload?.result?.rating,
    payload?.result?.value,
    payload?.data?.data?.score,
    payload?.data?.result?.score
  ];

  for (const item of candidates) {
    const value = Number(item);
    if (Number.isFinite(value)) return value;
  }

  return null;
}

async function getTradingViewRating(symbol) {
  if (!isEnabled(config.TRADINGVIEW_RATING_ENABLED) || !config.TRADINGVIEW_RATING_ENDPOINT) {
    return { score: 0, label: 'N/A' };
  }

  try {
    const res = await axios.get(
      `${config.TRADINGVIEW_RATING_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`,
      { timeout: 5000 }
    );

    const value = parseTvScore(res?.data);

    if (value === null) {
      console.warn(`[tradingviewRating] Unexpected payload for ${symbol}:`, res?.data);
      return { score: 0, label: 'N/A' };
    }

    const normalized = Math.max(0, Math.min(100, Number(value)));
    return {
      score: normalized,
      label: labelForScore(normalized)
    };
  } catch (err) {
    console.error(`[tradingviewRating] Fetch failed for ${symbol}:`, err?.message);
    return { score: 0, label: 'N/A' };
  }
}

module.exports = {
  getTradingViewRating
};
