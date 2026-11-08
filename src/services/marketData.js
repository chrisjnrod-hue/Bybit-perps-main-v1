const config = require('../config');
const bybitWs = require('./bybitWs');

function calculateMarketData(symbol, snapshot = {}) {
  const bids = Array.isArray(snapshot.bids) ? snapshot.bids : [];
  const asks = Array.isArray(snapshot.asks) ? snapshot.asks : [];

  const bestBid = bids.length ? Number(bids[0][0] || 0) : 0;
  const bestAsk = asks.length ? Number(asks[0][0] || 0) : 0;

  let bidDepthUsd = 0;
  let askDepthUsd = 0;

  for (const [price, quantity] of bids.slice(0, 10)) {
    bidDepthUsd += Number(price || 0) * Number(quantity || 0);
  }

  for (const [price, quantity] of asks.slice(0, 10)) {
    askDepthUsd += Number(price || 0) * Number(quantity || 0);
  }

  const spreadPct = bestBid > 0 && bestAsk > 0
    ? ((bestAsk - bestBid) / bestBid) * 100
    : 0;

  return {
    symbol,
    lastPrice: Number(snapshot.lastPrice || 0),
    volume24hUsd: Number(snapshot.volume24hUsd || 0),
    spreadPct,
    bestBid,
    bestAsk,
    bidDepthUsd,
    askDepthUsd,
    topOfBookDepthUsd: Math.min(bidDepthUsd, askDepthUsd),
    fundingRate: Number(snapshot.fundingRate || 0),
    fundingTime: snapshot.fundingTime || null
  };
}

async function buildMarketData(symbol) {
  if (config.USE_WS) {
    return calculateMarketData(symbol, bybitWs.getMarketSnapshot(symbol));
  }

  // REST market-data fallback is used only when WS is disabled.
  const {
    fetchOrderBook,
    fetchTicker,
    fetchFundingRate
  } = require('./bybitRest');

  const [orderBook, ticker, funding] = await Promise.all([
    fetchOrderBook(symbol, 25),
    fetchTicker(symbol),
    fetchFundingRate(symbol)
  ]);

  return calculateMarketData(symbol, {
    bids: Array.isArray(orderBook?.bids) ? orderBook.bids : [],
    asks: Array.isArray(orderBook?.asks) ? orderBook.asks : [],
    lastPrice: Number(ticker?.lastPrice || ticker?.last || 0),
    volume24hUsd: Number(ticker?.turnover24h || ticker?.volume24hUsd || 0),
    fundingRate: Number(funding?.fundingRate || 0),
    fundingTime: funding?.fundingTime || null
  });
}

function liquidityScoreFromMarketData(
  marketData,
  accountEquityUsd = 10000,
  targetPositionFrac = 0.01
) {
  const targetUsd = Number(accountEquityUsd || 0) * Number(targetPositionFrac || 0.01);
  const spreadPct = Number(marketData?.spreadPct || 0);
  const depth = Number(marketData?.topOfBookDepthUsd || 0);
  const volume24h = Number(marketData?.volume24hUsd || 0);

  let score = 100;
  if (spreadPct > Number(config.SPREAD_PERCENT || 0.05)) score -= 35;
  if (depth < targetUsd) score -= 30;
  if (volume24h < targetUsd * 2) score -= 25;

  return Math.max(0, Math.min(100, score));
}

async function evaluateLiquidityGate(
  symbol,
  accountEquityUsd = 10000,
  targetPositionFrac = 0.01
) {
  const marketData = await buildMarketData(symbol);
  const targetUsd = Number(accountEquityUsd || 0) * Number(targetPositionFrac || 0.01);

  const valid =
    Number(marketData.spreadPct || 0) <= Number(config.SPREAD_PERCENT || 0.05) &&
    Number(marketData.topOfBookDepthUsd || 0) >= targetUsd &&
    Number(marketData.volume24hUsd || 0) >= targetUsd * 2;

  return {
    valid,
    score: liquidityScoreFromMarketData(
      marketData,
      accountEquityUsd,
      targetPositionFrac
    ),
    marketData
  };
}

module.exports = {
  buildMarketData,
  calculateMarketData,
  liquidityScoreFromMarketData,
  evaluateLiquidityGate
};
