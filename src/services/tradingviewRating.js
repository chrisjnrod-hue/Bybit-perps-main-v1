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

async function getTradingViewRating(symbol) {
  const cleanSymbol = String(symbol || '').trim().toUpperCase();
  const tvSymbol = cleanSymbol.includes(':') ? cleanSymbol : `BINANCE:${cleanSymbol}`;

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

  const cacheMs = Math.max(0, Number(config.TRADINGVIEW_RATING_CACHE_MS || 60000));
  const cached = ratingCache.get(cleanSymbol);

  if (cached && Date.now() - cached.timestamp < cacheMs) {
    return cached.rating;
  }

  try {
    const interval = String(config.TRADINGVIEW_RATING_INTERVAL || '1D');
    
    // Dynamically import the ES Module to bypass CommonJS require restrictions
    const tvModule = await import('@mathieuc/tradingview/data');
    const getTechnicalAnalysis = tvModule.getTechnicalAnalysis;

    const analysis = await getTechnicalAnalysis({
      symbol: tvSymbol,
      interval: interval
    });

    const rawRecommendation = analysis?.recommendation?.value ?? analysis?.summary?.RECOMMENDATION;
    
    let score = null;
    if (typeof rawRecommendation === 'number') {
      score = Math.max(-1, Math.min(1, rawRecommendation));
    } else if (typeof rawRecommendation === 'string') {
      const lower = rawRecommendation.toLowerCase();
      if (lower.includes('strong_buy') || lower.includes('strong buy')) score = 1.0;
      else if (lower.includes('buy')) score = 0.5;
      else if (lower.includes('strong_sell') || lower.includes('strong sell')) score = -1.0;
      else if (lower.includes('sell')) score = -0.5;
      else score = 0.0;
    }

    if (score === null) {
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
      score: Number(score.toFixed(4)),
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
    console.error(`[tradingviewRating] Dynamic import/wrapper request failed for ${cleanSymbol}:`, error.message);

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
  labelForScore
};
