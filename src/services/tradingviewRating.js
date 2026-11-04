const axios = require('axios');
const config = require('../config');

function labelForScore(score) {
  if (score >= 80) return 'StrongBuy';
  if (score >= 65) return 'Buy';
  if (score >= 45) return 'Neutral';
  return 'Sell';
}

async function getTradingViewRating(symbol) {
  if (!config.TRADINGVIEW_RATING_ENABLED || !config.TRADINGVIEW_RATING_ENDPOINT) {
    return { score: 0, label: 'N/A' };
  }

  try {
    const res = await axios.get(
      `${config.TRADINGVIEW_RATING_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`,
      {
        timeout: 5000
      }
    );

    const value = Number(res?.data?.score ?? res?.data?.rating ?? 0);
    if (!Number.isFinite(value)) return { score: 0, label: 'N/A' };

    const normalized = Math.max(0, Math.min(100, value));
    return {
      score: normalized,
      label: labelForScore(normalized)
    };
  } catch (err) {
    return { score: 0, label: 'N/A' };
  }
}

module.exports = {
  getTradingViewRating
};
