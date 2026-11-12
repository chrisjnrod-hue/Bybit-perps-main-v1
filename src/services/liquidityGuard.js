/**
 * liquidityGuard.js
 * Unified Bybit V5 Market Scanner, Microstructure Analyzer, & Dynamic Position Sizer
 * Requires Node.js v18+ (built-in fetch & crypto)
 */

const crypto = require('crypto');

// Load external config if available, otherwise fall back to safe defaults
let userConfig = {};
try {
  userConfig = require('../config');
} catch (_) {
  // config.js not found; using built-in defaults below
}

const CONFIG = {
  baseUrl:
    process.env.BYBIT_API_URL ||
    userConfig.BYBIT_API_URL ||
    'https://api.bybit.com',
  apiKey: process.env.BYBIT_API_KEY || userConfig.BYBIT_API_KEY || '',
  apiSecret:
    process.env.BYBIT_API_SECRET || userConfig.BYBIT_API_SECRET || '',
  accountType: userConfig.accountType || 'UNIFIED',
  category: userConfig.category || 'linear',

  // Risk & Sizing Parameters
  riskPercentage: Number(userConfig.riskPercentage ?? 0.01), // 1% account risk per trade
  stopLossPercentage: Number(userConfig.stopLossPercentage ?? 0.015), // 1.5% stop loss
  takeProfitPercentage: Number(userConfig.takeProfitPercentage ?? 0.10), // 10.0% take profit
  maxNumberOfOpenTrades: Number(userConfig.maxNumberOfOpenTrades ?? 3),
  minNotional: Number(userConfig.minNotional ?? 5.0), // Bybit linear minimum ($5 USDT)

  // Liquidity & Microstructure Thresholds
  maxAllowedSpreadPct: Number(
    userConfig.maxAllowedSpread ? userConfig.maxAllowedSpread * 100 : 0.12
  ), // 0.12% max spread
  depthBandPct: Number(userConfig.depthBandPct ?? 0.005), // Measure order book within 0.5% of mid-price
  maxDepthImpact: Number(userConfig.maxDepthImpact ?? 0.10), // Cap order at 10% of available book depth
  scanIntervalMs: Number(userConfig.scanIntervalMs ?? 60000) // Auto-scan every 60 seconds when run directly
};

// Runtime state tracker
let currentOpenTrades = 0;

function setCurrentOpenTrades(value) {
  currentOpenTrades = Number(value || 0);
}

function getCurrentOpenTrades() {
  return currentOpenTrades;
}

/**
 * Generates HMAC SHA256 signature for Bybit V5 Private Endpoints
 */
function signRequest(timestamp, apiKey, secret, queryString) {
  const signString = `${timestamp}${apiKey}5000${queryString}`;
  return crypto.createHmac('sha256', secret).update(signString).digest('hex');
}

/**
 * 1. Fetches live total equity and USDT balances from Bybit Unified Account
 */
async function getAccountEquity(accountType = CONFIG.accountType) {
  if (!CONFIG.apiKey || !CONFIG.apiSecret) {
    throw new Error(
      'Missing BYBIT_API_KEY or BYBIT_API_SECRET environment variables.'
    );
  }

  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const queryString = `accountType=${accountType}`;
  const signature = signRequest(
    timestamp,
    CONFIG.apiKey,
    CONFIG.apiSecret,
    queryString
  );

  const response = await fetch(
    `${CONFIG.baseUrl}/v5/account/wallet-balance?${queryString}`,
    {
      method: 'GET',
      headers: {
        'X-BAPI-API-KEY': CONFIG.apiKey,
        'X-BAPI-SIGN': signature,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!response.ok) {
    throw new Error(`HTTP error fetching wallet balance: ${response.status}`);
  }

  const data = await response.json();
  if (data.retCode !== 0) {
    throw new Error(`Bybit Balance API Error (${data.retCode}): ${data.retMsg}`);
  }

  const accountInfo = data.result?.list?.[0];
  if (!accountInfo) {
    throw new Error(`No wallet data found for accountType: ${accountType}`);
  }

  const usdtCoin = accountInfo.coin?.find((c) => c.coin === 'USDT') || {};
  const totalEquity = Number(accountInfo.totalEquity || usdtCoin.equity || 0);

  return {
    totalEquityUsd: totalEquity,
    walletBalanceUsd: Number(usdtCoin.walletBalance || totalEquity),
    availableBalanceUsd: Number(usdtCoin.availableToWithdraw || totalEquity)
  };
}

/**
 * Helper: convert old/new liquidity call patterns into a target-notional USD.
 */
function resolveTargetPositionUsd(valueA, valueB) {
  const a = Number(valueA || 0);
  const b = Number(valueB || 0);

  // supports:
  // checkLiquidity(symbolInfo, targetPositionUsd)
  // checkLiquidity(symbolInfo, accountEquityUsd, targetPositionFrac)
  if (arguments.length >= 3 && b > 0) {
    return a * b;
  }

  return a;
}

/**
 * 2. Level-1 Quick Check (Used by the market-wide scanner)
 */
function checkLiquidity(symbolInfo = {}, targetPositionUsd = 0) {
  const volume24hUsd = Number(symbolInfo.volume24hUsd || 0);
  const spreadPct = Number(symbolInfo.spreadPct || 0);
  const topOfBookDepthUsd = Number(symbolInfo.topOfBookDepthUsd || 0);

  if (!Number.isFinite(targetPositionUsd) || targetPositionUsd <= 0) {
    return { valid: false, reason: 'invalid_target_position' };
  }

  if (spreadPct > CONFIG.maxAllowedSpreadPct) {
    return { valid: false, reason: 'spread_too_high' };
  }

  if (volume24hUsd < targetPositionUsd * 2) {
    return { valid: false, reason: 'insufficient_24h_volume' };
  }

  if (topOfBookDepthUsd < targetPositionUsd) {
    return { valid: false, reason: 'insufficient_top_depth' };
  }

  return { valid: true, reason: 'liquid' };
}

/**
 * 3. Market-Wide Scanner: Fetches live equity once and screens all USDT pairs
 */
async function scanLiquidSymbols(category = CONFIG.category, preFetchedEquityUsd = null) {
  const equityUsd =
    preFetchedEquityUsd ?? (await getAccountEquity()).totalEquityUsd;

  if (!Number.isFinite(equityUsd) || equityUsd <= 0) {
    throw new Error(
      'Account equity is $0 or invalid. Cannot calculate dynamic position sizing.'
    );
  }

  if (
    !Number.isFinite(CONFIG.riskPercentage) ||
    CONFIG.riskPercentage <= 0 ||
    !Number.isFinite(CONFIG.stopLossPercentage) ||
    CONFIG.stopLossPercentage <= 0
  ) {
    throw new Error(
      'Risk percentage and stop-loss percentage must be greater than zero.'
    );
  }

  const riskAmountUsd = equityUsd * CONFIG.riskPercentage;
  const targetPositionUsd = riskAmountUsd / CONFIG.stopLossPercentage;

  const response = await fetch(
    `${CONFIG.baseUrl}/v5/market/tickers?category=${encodeURIComponent(category)}`
  );

  if (!response.ok) {
    throw new Error(`HTTP error fetching tickers: ${response.status}`);
  }

  const data = await response.json();
  if (data.retCode !== 0) {
    throw new Error(`Bybit Tickers API Error (${data.retCode}): ${data.retMsg}`);
  }

  const tickers = data.result?.list || [];
  const liquidSymbols = [];

  for (const ticker of tickers) {
    if (!ticker.symbol?.endsWith('USDT')) continue;

    const bidPrice = Number(ticker.bid1Price || 0);
    const askPrice = Number(ticker.ask1Price || 0);
    const bidSize = Number(ticker.bid1Size || 0);
    const askSize = Number(ticker.ask1Size || 0);
    const volume24hUsd = Number(ticker.turnover24h || 0);

    if (bidPrice <= 0 || askPrice <= 0) continue;

    const spreadPct = ((askPrice - bidPrice) / askPrice) * 100;
    const topOfBookDepthUsd = Math.min(
      bidPrice * bidSize,
      askPrice * askSize
    );

    const symbolInfo = {
      symbol: ticker.symbol,
      lastPrice: Number(ticker.lastPrice || askPrice),
      volume24hUsd,
      spreadPct,
      topOfBookDepthUsd
    };

    // Use the dynamic equity-based liquidity threshold
    const status = checkLiquidity(symbolInfo, targetPositionUsd);

    if (status.valid) {
      liquidSymbols.push({
        ...symbolInfo,
        targetPositionUsd: Number(targetPositionUsd.toFixed(2)),
        ...status
      });
    }
  }

  // Sort most liquid pairs first by 24h volume
  liquidSymbols.sort((a, b) => b.volume24hUsd - a.volume24hUsd);

  return {
    accountEquityUsd: equityUsd,
    rawTargetNotionalUsd: Number(targetPositionUsd.toFixed(2)),
    liquidSymbols
  };
}

/**
 * 4. Deep 50-Level Order Book Analyzer (Used right before trade execution)
 */
async function analyzeOrderBook(symbol, side = 'Buy', thresholdPct = CONFIG.depthBandPct) {
  const endpoint = `/v5/market/orderbook?category=${CONFIG.category}&symbol=${symbol}&limit=50`;
  const response = await fetch(`${CONFIG.baseUrl}${endpoint}`);

  if (!response.ok) {
    throw new Error(`HTTP error fetching orderbook: ${response.status}`);
  }

  const data = await response.json();
  if (data.retCode !== 0) {
    throw new Error(`Bybit Orderbook API Error (${data.retCode}): ${data.retMsg}`);
  }

  const bids = data.result?.b || [];
  const asks = data.result?.a || [];

  if (bids.length === 0 || asks.length === 0) {
    throw new Error(`Empty order book returned for ${symbol}`);
  }

  const bestBid = parseFloat(bids[0][0]);
  const bestAsk = parseFloat(asks[0][0]);
  const midPrice = (bestBid + bestAsk) / 2;
  const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;

  let targetDepthValueUsd = 0;

  if (side === 'Buy') {
    for (const [priceStr, sizeStr] of asks) {
      const price = parseFloat(priceStr);
      const size = parseFloat(sizeStr);
      if (price <= midPrice * (1 + thresholdPct)) {
        targetDepthValueUsd += price * size;
      } else {
        break;
      }
    }
  } else {
    for (const [priceStr, sizeStr] of bids) {
      const price = parseFloat(priceStr);
      const size = parseFloat(sizeStr);
      if (price >= midPrice * (1 - thresholdPct)) {
        targetDepthValueUsd += price * size;
      } else {
        break;
      }
    }
  }

  return {
    bestBid,
    bestAsk,
    midPrice,
    spreadPct,
    targetDepthValueUsd
  };
}

/**
 * 5. Core Pre-Trade Evaluator: Combines Live Equity Scaling + 50-Level Depth Guards
 */
async function evaluateAndSizeTrade(symbol, side = 'Buy') {
  if (currentOpenTrades >= CONFIG.maxNumberOfOpenTrades) {
    return {
      execute: false,
      reason: 'MAX_TRADES_REACHED',
      details: `${currentOpenTrades}/${CONFIG.maxNumberOfOpenTrades} open trades`
    };
  }

  try {
    // Step 1: Fetch live equity and compute risk-adjusted target size
    const { totalEquityUsd } = await getAccountEquity();
    const riskAmountUsd = totalEquityUsd * CONFIG.riskPercentage;
    const rawPositionNotional = riskAmountUsd / CONFIG.stopLossPercentage;

    // Step 2: Inspect 50-level order book depth on the execution side
    const book = await analyzeOrderBook(symbol, side);

    // Guard A: Spread Check
    if (book.spreadPct > CONFIG.maxAllowedSpreadPct) {
      return {
        execute: false,
        reason: 'EXCESSIVE_SPREAD',
        spreadPct: Number(book.spreadPct.toFixed(4))
      };
    }

    // Guard B: Adaptive Order Book Impact Cap (prevents slippage on thin books)
    const maxSafeNotional = book.targetDepthValueUsd * CONFIG.maxDepthImpact;
    const finalPositionNotional = Math.min(rawPositionNotional, maxSafeNotional);

    // Guard C: Bybit Minimum Notional Enforcement
    if (finalPositionNotional < CONFIG.minNotional) {
      return {
        execute: false,
        reason: 'BELOW_MIN_NOTIONAL',
        calculatedNotional: Number(finalPositionNotional.toFixed(2)),
        minRequired: CONFIG.minNotional
      };
    }

    return {
      execute: true,
      symbol,
      side,
      accountEquityUsd: Number(totalEquityUsd.toFixed(2)),
      notionalSizeUsd: Number(finalPositionNotional.toFixed(2)),
      scaledDownForDepth: finalPositionNotional < rawPositionNotional,
      spreadPct: Number(book.spreadPct.toFixed(4)),
      reason: 'OK'
    };
  } catch (error) {
    console.error(`evaluateAndSizeTrade failed for ${symbol}:`, error.message);
    return {
      execute: false,
      reason: 'EVALUATION_ERROR',
      details: error.message
    };
  }
}

module.exports = {
  CONFIG,
  getAccountEquity,
  checkLiquidity,
  scanLiquidSymbols,
  analyzeOrderBook,
  evaluateAndSizeTrade,
  setCurrentOpenTrades,
  getCurrentOpenTrades
};
