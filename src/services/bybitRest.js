const axios = require('axios');
const config = require('../config');

const client = axios.create({
  baseURL: config.BYBIT_REST_BASE || 'https://api.bybit.com',
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

function normalizeUsdtSymbol(symbol) {
  if (!symbol) return null;
  const s = String(symbol).trim().toUpperCase();
  if (!s) return null;
  
  // Filter out delivery contracts or quarterly futures if any slip through
  if (/USDT[QHUZ0-9]/.test(s.slice(-6))) return null;
  
  // Must end with USDT or USDT.P
  if (!/USDT(\.P)?$/.test(s)) return null;

  // Skip symbols starting with numbers (e.g. 0GUSDT, 10000NEXUSDT) to prevent 400 Bad Request errors[cite: 1]
  if (/^[0-9]/.test(s)) return null;

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
            limit: 1000,
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
      const symbol = normalizeUsdtSymbol(item.symbol);
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
  const res = await safeBybitRequest(
    () =>
      client.get('/v5/market/kline', {
        params: {
          category: 'linear',
          symbol,
          interval,
          limit
        }
      }),
    `fetchKlines:${symbol}:${interval}`
  );

  if (!res) return [];

  const rows = res?.data?.result?.list || [];
  return rows.map((row) => ({
    open_time: Number(row.start || row[0] || 0),
    open: Number(row.open || row[1] || 0),
    high: Number(row.high || row[2] || 0),
    low: Number(row.low || row[3] || 0),
    close: Number(row.close || row[4] || 0),
    volume: Number(row.volume || row[5] || 0)
  }));
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
  const res = await safeBybitRequest(
    () =>
      client.get('/v5/market/orderbook', {
        params: {
          category: 'linear',
          symbol,
          limit
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
          limit: 1
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
