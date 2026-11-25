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

function mapIntervalSuffix(interval) {
  const raw = String(interval || '1D').trim().toUpperCase();
  if (raw === '1D' || raw === 'D' || raw === '24H') return '';
  if (raw === '4H' || raw === '240') return '|240';
  if (raw === '1H' || raw === '60') return '|60';
  if (raw === '15M' || raw === '15') return '|15';
  if (raw === '5M' || raw === '5') return '|5';
  return '';
}

async function queryTradingViewScanner(tickers, intervalSuffix) {
  const recommendField = `Recommend.All${intervalSuffix}`;
  const endpoint =
    String(config.TRADINGVIEW_RATING_ENDPOINT || '').trim() ||
    'https://scanner.tradingview.com/crypto/scan';
  const timeoutMs = Math.max(
    1000,
    Number(config.TRADINGVIEW_RATING_TIMEOUT_MS || 5000)
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
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
        columns: [recommendField]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const rows = Array.isArray(payload?.data) ? payload.data : [];

    for (const ticker of tickers) {
      const match = rows.find(
        (row) => String(row?.s || '').toUpperCase() === ticker.toUpperCase()
      );
      const val = match?.d?.[0];
      if (typeof val === 'number' && Number.isFinite(val)) {
        return Math.max(-1, Math.min(1, val));
      }
    }

    return null;
  } finally {
    clearTimeout(timeout);
  }
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
    const intervalSuffix = mapIntervalSuffix(
      config.TRADINGVIEW_RATING_INTERVAL || '1D'
    );

    const tickers = cleanSymbol.includes(':')
      ? [cleanSymbol]
      : [
          `BYBIT:${cleanSymbol}.P`,
          `BYBIT:${cleanSymbol}`,
          `BINANCE:${cleanSymbol}`
        ];

    const score = await queryTradingViewScanner(tickers, intervalSuffix);

    if (score === null) {
      console.warn(
        `[tradingviewRating] No Recommend.All data returned for ${tickers.join(', ')}`
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
      `[tradingviewRating] Scanner request failed for ${cleanSymbol}:`,
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
