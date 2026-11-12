const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');

const EQUITY_CACHE_MS = 30_000;
const INSTRUMENT_CACHE_MS = 60 * 60 * 1000;
const RECV_WINDOW = '5000';

let equityCache = {
  value: null,
  fetchedAt: 0
};

const instrumentCache = new Map();

function getBaseUrl() {
  return String(config.BYBIT_REST_BASE || 'https://api.bybit.com')
    .replace(/\/+$/, '');
}

function getAccountType() {
  return String(process.env.BYBIT_ACCOUNT_TYPE || 'UNIFIED');
}

function signGetRequest(timestamp, queryString) {
  const apiKey = config.BYBIT_API_KEY;
  const apiSecret = config.BYBIT_API_SECRET;

  const payload = `${timestamp}${apiKey}${RECV_WINDOW}${queryString}`;

  return crypto
    .createHmac('sha256', apiSecret)
    .update(payload)
    .digest('hex');
}

async function fetchAccountEquity() {
  if (
    equityCache.value !== null &&
    Date.now() - equityCache.fetchedAt < EQUITY_CACHE_MS
  ) {
    return equityCache.value;
  }

  if (!config.BYBIT_API_KEY || !config.BYBIT_API_SECRET) {
    throw new Error('BYBIT_API_KEY and BYBIT_API_SECRET are required to fetch equity.');
  }

  const accountType = getAccountType();
  const params = new URLSearchParams({ accountType });
  const queryString = params.toString();
  const timestamp = Date.now().toString();
  const signature = signGetRequest(timestamp, queryString);

  const response = await axios.get(
    `${getBaseUrl()}/v5/account/wallet-balance?${queryString}`,
    {
      timeout: Number(config.BYBIT_REST_TIMEOUT_MS || 7000),
      headers: {
        'X-BAPI-API-KEY': config.BYBIT_API_KEY,
        'X-BAPI-SIGN': signature,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW
      }
    }
  );

  const data = response?.data;
  if (Number(data?.retCode) !== 0) {
    throw new Error(
      `Bybit wallet-balance error (${data?.retCode}): ${data?.retMsg || 'Unknown error'}`
    );
  }

  const account = data?.result?.list?.[0];
  const usdt = account?.coin?.find((coin) => coin.coin === 'USDT');

  const equity = Number(account?.totalEquity || usdt?.equity || 0);
  if (!Number.isFinite(equity) || equity <= 0) {
    throw new Error('Bybit returned missing or invalid account equity.');
  }

  equityCache = {
    value: equity,
    fetchedAt: Date.now()
  };

  return equity;
}

async function fetchInstrumentRules(symbol) {
  const cleanSymbol = String(symbol || '').trim().toUpperCase();
  if (!cleanSymbol) throw new Error('A symbol is required to fetch instrument rules.');

  const cached = instrumentCache.get(cleanSymbol);
  if (cached && Date.now() - cached.fetchedAt < INSTRUMENT_CACHE_MS) {
    return cached.rules;
  }

  const params = new URLSearchParams({
    category: 'linear',
    symbol: cleanSymbol
  });

  const response = await axios.get(
    `${getBaseUrl()}/v5/market/instruments-info?${params.toString()}`,
    { timeout: Number(config.BYBIT_REST_TIMEOUT_MS || 7000) }
  );

  const data = response?.data;
  if (Number(data?.retCode) !== 0) {
    throw new Error(
      `Bybit instruments-info error (${data?.retCode}): ${data?.retMsg || 'Unknown error'}`
    );
  }

  const instrument = data?.result?.list?.[0];
  if (!instrument) {
    throw new Error(`Bybit returned no linear instrument rules for ${cleanSymbol}.`);
  }

  const lotSizeFilter = instrument.lotSizeFilter || {};
  const rules = {
    minOrderQty: Number(lotSizeFilter.minOrderQty || 0),
    qtyStep: Number(lotSizeFilter.qtyStep || 0),
    minNotionalValue: Number(
      lotSizeFilter.minNotionalValue || lotSizeFilter.minOrderAmt || 0
    )
  };

  instrumentCache.set(cleanSymbol, {
    rules,
    fetchedAt: Date.now()
  });

  return rules;
}

/**
 * Checks liquidity and whether the equity-based target is large enough for
 * the symbol's current Bybit minimum. This function does not size or submit
 * an order.
 *
 * symbolInfo should include:
 *   symbol, volume24hUsd, spreadPct, topOfBookDepthUsd, and lastPrice.
 */
async function checkLiquidity(symbolInfo = {}, options = {}) {
  const {
    targetPositionFrac = Number(config.TARGET_POSITION_FRAC || 0.01)
  } = options || {};

  let accountEquityUsd;
  let instrumentRules;

  try {
    [accountEquityUsd, instrumentRules] = await Promise.all([
      fetchAccountEquity(),
      fetchInstrumentRules(symbolInfo.symbol)
    ]);
  } catch (error) {
    return {
      valid: false,
      reason: 'liquidity_data_unavailable',
      detail: error.message
    };
  }

  const volume24hUsd = Number(
    symbolInfo.volume24hUsd || symbolInfo.turnover24h || 0
  );
  const spreadPct = Number(symbolInfo.spreadPct || 0);
  const topOfBookDepthUsd = Number(symbolInfo.topOfBookDepthUsd || 0);
  const lastPrice = Number(symbolInfo.lastPrice || 0);

  const fraction = Number(targetPositionFrac);
  if (!Number.isFinite(fraction) || fraction <= 0) {
    return {
      valid: false,
      reason: 'invalid_target_position_fraction',
      accountEquityUsd
    };
  }

  const targetPositionUsd = accountEquityUsd * fraction;
  const maxSpreadPct = Number(config.SPREAD_PERCENT || 0.05);

  // Bybit linear instruments generally expose minNotionalValue. If it is
  // absent, estimate the notional from minOrderQty and the current price.
  const minimumOrderNotionalUsd =
    instrumentRules.minNotionalValue > 0
      ? instrumentRules.minNotionalValue
      : instrumentRules.minOrderQty > 0 && lastPrice > 0
        ? instrumentRules.minOrderQty * lastPrice
        : null;

  if (spreadPct > maxSpreadPct) {
    return {
      valid: false,
      reason: 'spread_too_high',
      spreadPct,
      maxSpreadPct,
      accountEquityUsd,
      targetPositionUsd,
      minimumOrderNotionalUsd
    };
  }

  if (minimumOrderNotionalUsd === null) {
    return {
      valid: false,
      reason: 'minimum_order_notional_unavailable',
      accountEquityUsd,
      targetPositionUsd,
      minOrderQty: instrumentRules.minOrderQty,
      qtyStep: instrumentRules.qtyStep
    };
  }

  // Do not raise a too-small target automatically: doing so could exceed the
  // configured risk allocation for a small account.
  if (targetPositionUsd < minimumOrderNotionalUsd) {
    return {
      valid: false,
      reason: 'target_below_exchange_minimum',
      accountEquityUsd,
      targetPositionUsd,
      minimumOrderNotionalUsd,
      minOrderQty: instrumentRules.minOrderQty,
      qtyStep: instrumentRules.qtyStep
    };
  }

  if (volume24hUsd < targetPositionUsd * 2) {
    return {
      valid: false,
      reason: 'insufficient_24h_volume',
      accountEquityUsd,
      targetPositionUsd,
      volume24hUsd,
      minimumVolumeUsd: targetPositionUsd * 2,
      minimumOrderNotionalUsd
    };
  }

  if (topOfBookDepthUsd < targetPositionUsd) {
    return {
      valid: false,
      reason: 'insufficient_top_depth',
      accountEquityUsd,
      targetPositionUsd,
      topOfBookDepthUsd,
      minimumDepthUsd: targetPositionUsd,
      minimumOrderNotionalUsd
    };
  }

  return {
    valid: true,
    reason: 'liquid',
    accountEquityUsd,
    targetPositionUsd,
    minimumOrderNotionalUsd,
    minOrderQty: instrumentRules.minOrderQty,
    qtyStep: instrumentRules.qtyStep,
    volume24hUsd,
    spreadPct,
    topOfBookDepthUsd
  };
}

module.exports = {
  checkLiquidity,
  fetchAccountEquity,
  fetchInstrumentRules
};
