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
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

function mapIntervalToTvColumn(interval) {
  const raw = String(interval || '1D').trim().toUpperCase();
  if (raw === '1D' || raw === 'D') return 'Recommend.All';
  if (raw === '1W' || raw === 'W') return 'Recommend.All|1W';
  if (raw === '1M' || raw === 'M') return 'Recommend.All|1M';
  if (raw === '4H' || raw === '240') return 'Recommend.All|240';
  if (raw === '1H' || raw === '60') return 'Recommend.All|60';
  if (raw === '15M' || raw === '15') return 'Recommend.All|15';
  if (raw === '5M' || raw === '5') return 'Recommend.All|5';
  return 'Recommend.All';
}

function buildCandidateTickers(cleanSymbol) {
  if (cleanSymbol.includes(':')) {
    return [cleanSymbol];
  }

  const base = cleanSymbol.replace(/\.P$/i, '');
  return [
    `BYBIT:${base}.P`,
    `BYBIT:${base}`,
    `BINANCE:${base}.P`,
    `BINANCE:${base}`
  ];
}

async function fetchFromTvScanner(tickers, column) {
  const response = await fetch('https://scanner.tradingview.com/crypto/scan', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    },
    body: JSON.stringify({
      symbols: {
        tickers,
        query: { types: [] }
      },
      columns: [column]
    })
  });

  if (!response.ok) {
    throw new Error(`TradingView scanner HTTP ${response.status}`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  // Match in priority order of candidate tickers
  for (const ticker of tickers) {
    const match = rows.find((row) => String(row?.s || '').toUpperCase() === ticker);
    const val = match?.d?.[0];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
  }

  // Fallback to first valid numeric value returned
  for (const row of rows) {
    const val = row?.d?.[0];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
  }

  return null;
}

async function fetchFromTvLibrary(tvSymbol, interval) {
  const tvMod = await import('@mathieuc/tradingview').catch(() => null);
  const getTechnicalAnalysis = tvMod?.getTechnicalAnalysis || tvMod?.default?.getTechnicalAnalysis;
  if (typeof getTechnicalAnalysis !== 'function') return null;

  const analysis = await getTechnicalAnalysis(tvSymbol, interval).catch(() => null);
  const rawRecommendation =
    analysis?.recommendation?.value ??
    analysis?.summary?.RECOMMENDATION ??
    analysis?.RECOMMENDATION ??
    analysis?.indicators?.['Recommend.All'];

  if (typeof rawRecommendation === 'number' && Number.isFinite(rawRecommendation)) {
    return rawRecommendation;
  }

  if (typeof rawRecommendation === 'string') {
    const lower = rawRecommendation.toLowerCase();
    if (lower.includes('strong_buy') || lower.includes('strong buy')) return 1.0;
    if (lower.includes('buy')) return 0.5;
    if (lower.includes('strong_sell') || lower.includes('strong sell')) return -1.0;
    if (lower.includes('sell')) return -0.5;
    return 0.0;
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

  const cacheMs = Math.max(0, Number(config.TRADINGVIEW_RATING_CACHE_MS || 60000));
  const cached = ratingCache.get(cleanSymbol);

  if (cached && Date.now() - cached.timestamp < cacheMs) {
    return cached.rating;
  }

  try {
    const interval = String(config.TRADINGVIEW_RATING_INTERVAL || '1D');
    const column = mapIntervalToTvColumn(interval);
    const tickers = buildCandidateTickers(cleanSymbol);

    let rawScore = await fetchFromTvScanner(tickers, column).catch(() => null);

    if (rawScore === null) {
      rawScore = await fetchFromTvLibrary(tickers[0], interval);
    }

    if (rawScore === null || !Number.isFinite(rawScore)) {
      return {
        available: false,
        score: null,
        percent: null,
        label: 'N/A',
        source: 'TradingView'
      };
    }

    const score = Math.max(-1, Math.min(1, rawScore));

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
    console.error(`[tradingviewRating] Request failed for ${cleanSymbol}:`, error.message);

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
