const axios = require('axios');
const config = require('../config');

async function getTradingViewRating(symbol) {
  if (!config.TRADINGVIEW_RATING_ENABLED || !config.TRADINGVIEW_RATING_ENDPOINT) {
    return { score: 0, label: 'N/A' };
  }

  try {
    const res = await axios.get(`${config.TRADINGVIEW_RATING_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`, {
      timeout: 5000
    });

    const value = Number(res?.data?.score ?? res?.data?.rating ?? 0);
    if (!Number.isFinite(value)) return { score: 0, label: 'N/A' };

    const normalized = Math.max(0, Math.min(100, value));
    let label = 'Sell';
    if (normalized >= 80) label = 'StrongBuy';
    else if (normalized >= 65) label = 'Buy';
    else if (normalized >= 45) label = 'Neutral';

    return { score: normalized, label };
  } catch (err) {
    return { score: 0, label: 'N/A' };
  }
}

module.exports = {
  getTradingViewRating
};