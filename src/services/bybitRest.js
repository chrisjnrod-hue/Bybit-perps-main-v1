const axios = require('axios');
const config = require('../config');

const client = axios.create({
  baseURL: config.BYBIT_REST_BASE || 'https://bybit.com',
  timeout: config.BYBIT_REST_TIMEOUT_MS || 7000
});

const rateLimiter = {
  lastCallAt: 0,
  intervalMs: Math.max(50, Number(config.BYBIT_FETCH_RATE_LIMIT_MS || 250))
};

async function waitForRateLimit() {
  const now = Date.now();
  const elapsed = now - rateLimiter.lastCallAt;
  const wait = Math.max(0, rateLimiter.intervalMs - elapsed);

  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  rateLimiter.lastCallAt = Date.now();
}

async function safeBybitRequest(fn, context = 'request') {
  try {
    await waitForRateLimit();
    return await fn();
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;

    if ([400, 402, 403, 404, 429].includes(status)) {
      console.warn(`[Bybit ${context}] skipped due to ${status}:`, data || err.message);
      return null;
    }

    throw err;
  }
}

function normalizeUsdtSymbol(symbol, contractType = 'LinearPerpetual') {
  if (!symbol) return null;
  const s = String(symbol).trim().toUpperCase();
  if (!s) return null;

  // Must end with USDT or USDT.P
  if (!/USDT(\.P)?$/.test(s)) return null;

  // Enforce Linear Perpetual contract type if metadata is provided
  if (contractType && contractType !== 'LinearPerpetual') {
    return null;
  }

  // Filter out quarterly/delivery futures contracts
  if (/-[0-9]{2}[A-Z]{3}[0-9]{2}$/.test(s) || /[0-9]{2}[A-Z]{3}[0-9]{2}/.test(s)) {
    return null;
  }

  // Skip tokens starting with numbers or multiplier prefixes (e.g. 10000NEXUSDT, 0GUSDT)
  if (/^[0-9]/.test(s)) return null;

  // Exclude stock perpetuals or equity tickers
  const stockSymbols = ['AALUSDT', 'AAOIUSDT', 'TSLAUSDT', 'NVDAUSDT', 'AAPLUSDT', 'MSFTUSDT'];
  if (stockSymbols.includes(s)) {
    return null;
  }

  return s;
}

async function fetchAllSymbols() {
  const list = [];
  let cursor = null;

  while (true) {
    const res = await safeBybitRequest(
      () =>
        client.get('/v5/market/instruments-info', {
          params: {
            category: 'linear',
            status: 'Trading',
            limit: '1000', // String cast to fit API strict formats
            ...(cursor ? { cursor } : {})
          }
        }),
      'fetchAllSymbols'
    );

    if (!res) {
      if (!cursor) break;
      cursor = null;
      continue;
    }

    const page = res?.data?.result?.list || [];
    for (const item of page) {
      const symbol = normalizeUsdtSymbol(item.symbol, item.contractType);
      if (!symbol) continue;

      list.push({
        symbol,
        base: item.baseCoin || symbol.replace(/USDT(\.P)?$/i, ''),
        quote: item.quoteCoin || 'USDT'
      });
    }

    cursor = res?.data?.result?.nextPageCursor || null;
    if (!cursor) break;
  }

  const dedup = new Map();
  for (const item of list) {
    dedup.set(item.symbol, item);
  }

  return [...dedup.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

async function fetchKlines(symbol, interval = 'D', limit = 200) {
  // 1. Force strict bounds checks on limits to prevent Bybit boundary exceptions
  const parsedLimit = Number(limit);
  const enforcedLimit = Math.min(200, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 120));

  // 2. Strict whitelist fallback match for Bybit V5 valid intervals
  const validIntervals = ['1', '3', '5', '15', '30', '60', '120', '240', '360', '720', 'D', 'M', 'W'];
  
  let enforcedInterval = String(interval).trim();
  if (enforcedInterval === '1D' || enforcedInterval === 'd') {
    enforcedInterval = 'D';
  }

  // Circuit breaker: Force a fallback to 'D' if a bad or missing interval gets passed out
  if (!validIntervals.includes(enforcedInterval)) {
    console.warn(`[Bybit Scanner Override] Invalid interval "${interval}" detected for ${symbol}. Defaulting safely to "D".`);
    enforcedInterval = 'D';
  }

  const res = await safeBybitRequest(
    () =>
      client.get('/v5/market/kline', {
        params: {
          category: 'linear',
          symbol: String(symbol).toUpperCase().trim(),
          interval: String(enforcedInterval), // Ensure type is strictly a string primitive
          limit: String(enforcedLimit)
        }
      }),
    `fetchKlines:${symbol}:${enforcedInterval}`
  );

  if (!res) return [];

  const rows = res?.data?.result?.list || [];
  
  // Clean array extraction structure to handle Bybit V5 nested item layouts safely
  return rows.map((row) => {
    if (Array.isArray(row)) {
      return {
        open_time: Number(row[0] || 0),
        open: Number(row[1] || 0),
        high: Number(row[2] || 0),
        low: Number(row[3] || 0),
        close: Number(row[4] || 0),
        volume: Number(row[5] || 0)
      };
    }
    
    return {
      open_time: Number(row.start || 0),
      open: Number(row.open || 0),
      high: Number(row.high || 0),
      low: Number(row.low || 0),
      close: Number(row.close || 0),
      volume: Number(row.volume || 0)
    };
  });
}

async function fetchTicker(symbol) {
  const res = await safeBybitRequest(
    () =>
      client.get('/v5/market/tickers', {
        params: {
          category: 'linear',
          symbol
        }
      }),
    `fetchTicker:${symbol}`
  );

  if (!res) return null;

  const list = res?.data?.result?.list || [];
  return list[0] || null;
}

async function fetchOrderBook(symbol, limit = 25) {
  // Enforce Bybit's orderbook limits (max 50 for linear)
  const enforcedLimit = Math.min(50, Math.max(1, Number(limit)));

  const res = await safeBybitRequest(
    () =>
      client.get('/v5/market/orderbook', {
        params: {
          category: 'linear',
          symbol,
          limit: String(enforcedLimit)
        }
      }),
    `fetchOrderBook:${symbol}`
  );

  if (!res) {
    return { bids: [], asks: [] };
  }

  const result = res?.data?.result || {};
  return {
    bids: Array.isArray(result.b) ? result.b : [],
    asks: Array.isArray(result.a) ? result.a : []
  };
}

async function fetchFundingRate(symbol) {
  const res = await safeBybitRequest(
    () =>
      client.get('/v5/market/funding/history', {
        params: {
          category: 'linear',
          symbol,
          limit: '1'
        }
      }),
    `fetchFundingRate:${symbol}`
  );

  if (!res) return null;

  const list = res?.data?.result?.list || [];
  return list[0] || null;
}

module.exports = {
  fetchAllSymbols,
  fetchKlines,
  fetchTicker,
  fetchOrderBook,
  fetchFundingRate,
  normalizeUsdtSymbol
};
