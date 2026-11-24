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

async function fetchTvAnalysisForTicker(
  getTechnicalAnalysis,
  tvSymbol,
  exchange,
  interval
) {
  const analysis =
    (await getTechnicalAnalysis({
      symbol: tvSymbol,
      interval,
      screener: 'crypto',
      exchange
    }).catch(() => null)) ??
    (await getTechnicalAnalysis({
      symbol: tvSymbol,
      interval
    }).catch(() => null));

  if (!analysis) return null;

  const rawRecommendation =
    analysis?.recommendation?.value ??
    analysis?.summary?.RECOMMENDATION ??
    analysis?.RECOMMENDATION ??
    analysis?.compute?.RECOMMENDATION ??
    analysis?.value ??
    analysis?.indicators?.['Recommend.All'];

  if (typeof rawRecommendation === 'number' && Number.isFinite(rawRecommendation)) {
    return Math.max(-1, Math.min(1, rawRecommendation));
  }

  if (typeof rawRecommendation === 'string') {
    const lower = rawRecommendation.toLowerCase();
    if (lower.includes('strong_buy') || lower.includes('strong buy')) return 1.0;
    if (lower.includes('buy')) return 0.5;
    if (lower.includes('strong_sell') || lower.includes('strong sell')) return -1.0;
    if (lower.includes('sell')) return -0.5;
    if (lower.includes('neutral')) return 0.0;
  }

  return null;
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

  const cacheMs = Math.max(
    0,
    Number(config.TRADINGVIEW_RATING_CACHE_MS || 60000)
  );
  const cached = ratingCache.get(cleanSymbol);

  if (cached && Date.now() - cached.timestamp < cacheMs) {
    return cached.rating;
  }

  try {
    const interval = String(config.TRADINGVIEW_RATING_INTERVAL || '1D');

    const tvModule = await import('@mathieuc/tradingview/data');
    const getTechnicalAnalysis = tvModule.getTechnicalAnalysis;

    const candidates = cleanSymbol.includes(':')
      ? [{ tvSymbol: cleanSymbol, exchange: cleanSymbol.split(':')[0] }]
      : [
          { tvSymbol: `BYBIT:${cleanSymbol}.P`, exchange: 'BYBIT' },
          { tvSymbol: `BYBIT:${cleanSymbol}`, exchange: 'BYBIT' },
          { tvSymbol: `BINANCE:${cleanSymbol}`, exchange: 'BINANCE' }
        ];

    let score = null;
    for (const candidate of candidates) {
      score = await fetchTvAnalysisForTicker(
        getTechnicalAnalysis,
        candidate.tvSymbol,
        candidate.exchange,
        interval
      );
      if (score !== null) break;
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
    console.error(
      `[tradingviewRating] Request failed for ${cleanSymbol}:`,
      error.message
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
  labelForScore
};
