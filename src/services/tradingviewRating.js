const axios = require('axios');
const config = require('../config');

const ratingCache = new Map();

function labelForScore(score) {
  if (score >= 0.5) return 'Strong Buy';
  if (score >= 0.1) return 'Buy';
  if (score <= -0.5) return 'Strong Sell';
  if (score <= -0.1) return 'Sell';
  return 'Neutral';
}

function isEnabled(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

function asFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function recommendationToScore(value) {
  if (typeof value !== 'string') return null;

  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  const scores = {
    STRONG_BUY: 1,
    BUY: 0.5,
    NEUTRAL: 0,
    SELL: -0.5,
    STRONG_SELL: -1
  };

  return Object.prototype.hasOwnProperty.call(scores, normalized)
    ? scores[normalized]
    : null;
}

function normalizeNumericScore(value) {
  const numeric = asFiniteNumber(value);
  if (numeric === null) return null;

  // Native TradingView technical-rating scale.
  if (numeric >= -1 && numeric <= 1) return numeric;

  // Accept a 0..100 rating and convert it to TradingView's -1..1 scale.
  if (numeric >= 0 && numeric <= 100) {
    return (numeric / 50) - 1;
  }

  return null;
}

function parseTvRating(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const objects = [
    payload,
    payload.data,
    payload.result,
    payload.data?.data,
    payload.data?.result,
    payload.result?.data,
    payload.summary,
    payload.data?.summary,
    payload.result?.summary
  ].filter((item) => item && typeof item === 'object');

  // Prefer explicitly named technical-rating fields over generic scores.
  const numericKeys = [
    'technicalRating',
    'technical_rating',
    'rating',
    'score',
    'value'
  ];

  for (const object of objects) {
    for (const key of numericKeys) {
      const score = normalizeNumericScore(object[key]);
      if (score !== null) return score;
    }
  }

  // TradingView-style recommendation strings.
  const recommendationKeys = [
    'RECOMMENDATION',
    'recommendation',
    'ratingText',
    'label'
  ];

  for (const object of objects) {
    for (const key of recommendationKeys) {
      const score = recommendationToScore(object[key]);
      if (score !== null) return score;
    }
  }

  return null;
}

function buildEndpointUrl(symbol) {
  const endpoint = String(config.TRADINGVIEW_RATING_ENDPOINT || '').trim();
  if (!endpoint) return null;

  const encodedSymbol = encodeURIComponent(symbol);
  const interval = encodeURIComponent(
    String(config.TRADINGVIEW_RATING_INTERVAL || '1D')
  );

  if (endpoint.includes('{symbol}') || endpoint.includes('{interval}')) {
    return endpoint
      .replaceAll('{symbol}', encodedSymbol)
      .replaceAll('{interval}', interval);
  }

  const url = new URL(endpoint);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', String(config.TRADINGVIEW_RATING_INTERVAL || '1D'));
  return url.toString();
}

async function getTradingViewRating(symbol) {
  const cleanSymbol = String(symbol || '').trim().toUpperCase();

  if (!cleanSymbol) {
    return {
      available: false,
      score: null,
      percent: null,
      label: 'N/A',
      source: 'TradingView'
    };
  }

  if (!isEnabled(config.TRADINGVIEW_RATING_ENABLED)) {
    return {
      available: false,
      score: null,
      percent: null,
      label: 'Disabled',
      source: 'TradingView'
    };
  }

  if (!config.TRADINGVIEW_RATING_ENDPOINT) {
    console.warn('[tradingviewRating] Enabled, but no endpoint is configured.');
    return {
      available: false,
      score: null,
      percent: null,
      label: 'N/A',
      source: 'TradingView'
    };
  }

  const cacheMs = Math.max(0, Number(config.TRADINGVIEW_RATING_CACHE_MS || 60000));
  const cached = ratingCache.get(cleanSymbol);

  if (cached && Date.now() - cached.timestamp < cacheMs) {
    return cached.rating;
  }

  try {
    const url = buildEndpointUrl(cleanSymbol);
    const response = await axios.get(url, {
      timeout: Number(config.TRADINGVIEW_RATING_TIMEOUT_MS || 5000)
    });

    const score = parseTvRating(response?.data);

    if (score === null) {
      console.warn(
        `[tradingviewRating] Could not parse technical rating for ${cleanSymbol}.`,
        response?.data
      );

      return {
        available: false,
        score: null,
        percent: null,
        label: 'N/A',
        source: 'TradingView'
      };
    }

    const rating = {
      available: true,
      // Native TradingView scale, -1 (strong sell) to +1 (strong buy).
      score: Number(score.toFixed(4)),
      // Display-only conversion: 0% (strong sell) to 100% (strong buy).
      percent: Number((((score + 1) / 2) * 100).toFixed(1)),
      label: labelForScore(score),
      source: 'TradingView'
    };

    ratingCache.set(cleanSymbol, {
      timestamp: Date.now(),
      rating
    });

    return rating;
  } catch (error) {
    console.error(
      `[tradingviewRating] Request failed for ${cleanSymbol}:`,
      error?.response?.status || error?.message
    );

    return {
      available: false,
      score: null,
      percent: null,
      label: 'N/A',
      source: 'TradingView'
    };
  }
}

module.exports = {
  getTradingViewRating,
  parseTvRating,
  labelForScore
};
