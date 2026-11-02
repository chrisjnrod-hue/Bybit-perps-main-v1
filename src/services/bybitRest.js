const axios = require('axios');
const config = require('../config');

const baseURL = (config.BYBIT_REST_BASE || 'https://api.bybit.com').replace(/\/+$/, '');

const client = axios.create({
  baseURL,
  timeout: Number(config.BYBIT_REST_TIMEOUT_MS || 7000)
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

function formatBybitError(err) {
  const reqConfig = err?.config || {};
  const url =
    reqConfig.baseURL && reqConfig.url
      ? new URL(reqConfig.url, reqConfig.baseURL).toString()
      : reqConfig.url || 'unknown';

  return {
    url,
    method: reqConfig.method || 'GET',
    params: reqConfig.params || {},
    status: err?.response?.status || null,
    statusText: err?.response?.statusText || null,
    retCode: err?.response?.data?.retCode || null,
    retMsg: err?.response?.data?.retMsg || null,
    rawData: err?.response?.data || null,
    message: err?.message || null
  };
}

// Show failures clearly, but only swallow them when explicitly requested.
async function safeBybitRequest(fn, context = 'request', options = {}) {
  const { swallowHttpErrors = false } = options;

  try {
    await waitForRateLimit();
    return await fn();
  } catch (err) {
    const info = formatBybitError(err);

    console.error('=== BYBIT FAILURE ===');
    console.error('context:', context);
    console.error('method:', info.method);
    console.error('url:', info.url);
    console.error('params:', JSON.stringify(info.params, null, 2));
    console.error('status:', info.status);
    console.error('statusText:', info.statusText);
    console.error('retCode:', info.retCode);
    console.error('retMsg:', info.retMsg);
    console.error('rawData:', JSON.stringify(info.rawData, null, 2));
    console.error('axios message:', info.message);
    console.error('stack:', err?.stack);
    console.error('====================');

    const status = err?.response?.status;

    if ([400, 402, 403, 404, 429].includes(status)) {
      console.error(`[Bybit ${context}] HTTP ${status}: ${info.retMsg || info.message}`);

      if (swallowHttpErrors) {
        return null;
      }

      throw err;
    }

    throw err;
  }
}

function normalizeUsdtSymbol(symbol, contractType = 'LinearPerpetual') {
  if (!symbol) return null;

  const s = String(symbol).trim().toUpperCase();
  if (!s) return null;

  if (!/USDT(\.P)?$/.test(s)) return null;

  if (contractType && String(contractType).trim().toUpperCase() !== 'LINEARPERPETUAL') {
    return null;
  }

  if (/-[0-9]{2}[A-Z]{3}[0-9]{2}$/.test(s) || /[0-9]{2}[A-Z]{3}[0-9]{2}/.test(s)) {
    return null;
  }

  if (/^[0-9]/.test(s)) return null;

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
    const requestParams = {
      category: 'linear',
      limit: 1000,
      ...(cursor ? { cursor } : {})
    };

    console.log('[bybitRest] fetchAllSymbols start');
    console.log('[bybitRest] baseURL =', client.defaults.baseURL);
    console.log('[bybitRest] request params =', JSON.stringify(requestParams, null, 2));

    const res = await safeBybitRequest(
      () =>
        client.get('/v5/market/instruments-info', {
          params: requestParams
        }),
      'fetchAllSymbols',
      { swallowHttpErrors: false }
    );

    if (!res) {
      throw new Error('fetchAllSymbols returned null; upstream request failed.');
    }

    const page = res?.data?.result?.list || [];

    for (const item of page) {
      if (String(item?.status || '').trim() !== 'Trading') continue;

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
  const cleanSymbol = String(symbol || '').toUpperCase().trim();
  const cleanInterval = String(interval || 'D').trim();
  const cleanLimit = String(limit || 200);

  const candidates = [
    {
      path: '/v5/market/kline',
      params: {
        category: 'linear',
        symbol: cleanSymbol,
        interval: cleanInterval,
        limit: cleanLimit
      }
    },
    {
      path: '/v2/public/kline',
      params: {
        symbol: cleanSymbol,
        interval: cleanInterval,
        limit: cleanLimit
      }
    },
    {
      path: '/v2/public/kline/list',
      params: {
        symbol: cleanSymbol,
        interval: cleanInterval,
        limit: cleanLimit
      }
    }
  ];

  function normalizeRows(json) {
    const v5List = json?.result?.list;
    if (Array.isArray(v5List)) {
      return v5List.map((row) => ({
        open_time: Number(row?.start ?? row?.[0] ?? 0),
        open: Number(row?.open ?? row?.[1] ?? 0),
        high: Number(row?.high ?? row?.[2] ?? 0),
        low: Number(row?.low ?? row?.[3] ?? 0),
        close: Number(row?.close ?? row?.[4] ?? 0),
        volume: Number(row?.volume ?? row?.[5] ?? 0)
      }));
    }

    const rows = Array.isArray(json?.result)
      ? json.result
      : Array.isArray(json)
        ? json
        : [];

    return rows.map((row) => ({
      open_time: Number(row?.start ?? row?.start_at ?? row?.t ?? row?.open_time ?? row?.[0] ?? 0),
      open: Number(row?.open ?? row?.o ?? row?.[1] ?? 0),
      high: Number(row?.high ?? row?.h ?? row?.[2] ?? 0),
      low: Number(row?.low ?? row?.l ?? row?.[3] ?? 0),
      close: Number(row?.close ?? row?.c ?? row?.[4] ?? 0),
      volume: Number(row?.volume ?? row?.v ?? row?.[5] ?? 0)
    }));
  }

  for (const candidate of candidates) {
    try {
      console.info('[bybitRest] fetchKlines trying', {
        baseURL: client.defaults.baseURL,
        path: candidate.path,
        params: candidate.params
      });

      const response = await safeBybitRequest(
        () =>
          client.get(candidate.path, {
            params: candidate.params,
            timeout: 8000
          }),
        `fetchKlines:${cleanSymbol}:${cleanInterval}:${candidate.path}`
      );

      const json = response?.data;

      if (!json) {
        console.warn('[bybitRest] fetchKlines got an empty response', {
          symbol: cleanSymbol,
          path: candidate.path
        });
        continue;
      }

      const retCode = json.retCode ?? json.ret_code;
      if (typeof retCode !== 'undefined' && Number(retCode) !== 0) {
        console.warn('[bybitRest] fetchKlines API error; trying next endpoint', {
          symbol: cleanSymbol,
          path: candidate.path,
          retCode,
          retMsg: json.retMsg ?? json.ret_msg ?? null,
          response: json
        });
        continue;
      }

      const rows = normalizeRows(json);
      if (rows.length > 0) {
        console.info('[bybitRest] fetchKlines succeeded', {
          symbol: cleanSymbol,
          path: candidate.path,
          count: rows.length
        });
        return rows;
      }

      console.warn('[bybitRest] fetchKlines returned no rows; trying next endpoint', {
        symbol: cleanSymbol,
        path: candidate.path,
        response: json
      });
    } catch (err) {
      console.error('[bybitRest] fetchKlines endpoint failed; trying next endpoint', {
        symbol: cleanSymbol,
        path: candidate.path,
        message: err?.message,
        status: err?.response?.status,
        statusText: err?.response?.statusText,
        retCode: err?.response?.data?.retCode ?? err?.response?.data?.ret_code ?? null,
        retMsg: err?.response?.data?.retMsg ?? err?.response?.data?.ret_msg ?? null,
        response: err?.response?.data ?? null
      });
    }
  }

  console.error('[bybitRest] all kline endpoints failed', {
    symbol: cleanSymbol,
    interval: cleanInterval,
    baseURL: client.defaults.baseURL
  });

  return [];
}

async function fetchTicker(symbol) {
  const res = await safeBybitRequest(
    () =>
      client.get('/v5/market/tickers', {
        params: {
          category: 'linear',
          symbol: String(symbol).toUpperCase().trim()
        }
      }),
    `fetchTicker:${symbol}`
  );

  if (!res) return null;

  const list = res?.data?.result?.list || [];
  return list[0] || null;
}

async function fetchOrderBook(symbol, limit = 25) {
  const enforcedLimit = Math.min(50, Math.max(1, Number(limit)));

  const res = await safeBybitRequest(
    () =>
      client.get('/v5/market/orderbook', {
        params: {
          category: 'linear',
          symbol: String(symbol).toUpperCase().trim(),
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
          symbol: String(symbol).toUpperCase().trim(),
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
