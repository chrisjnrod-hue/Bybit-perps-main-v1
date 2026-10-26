const { fetchOrderBook, fetchTicker, fetchFundingRate } = require('./bybitRest');
const config = require('../config');

async function buildMarketData(symbol) {
  const orderBook = await fetchOrderBook(symbol, 25);
  const ticker = await fetchTicker(symbol);
  const funding = await fetchFundingRate(symbol);

  const bids = Array.isArray(orderBook?.bids) ? orderBook.bids : [];
  const asks = Array.isArray(orderBook?.asks) ? orderBook.asks : [];

  let bestBid = 0;
  let bestAsk = 0;
  let bidDepthUsd = 0;
  let askDepthUsd = 0;

  if (bids.length) {
    bestBid = Number(bids[0][0] || 0);
    for (const level of bids.slice(0, 10)) {
      const price = Number(level[0] || 0);
      const qty = Number(level[1] || 0);
      bidDepthUsd += price * qty;
    }
  }

  if (asks.length) {
    bestAsk = Number(asks[0][0] || 0);
    for (const level of asks.slice(0, 10)) {
      const price = Number(level[0] || 0);
      const qty = Number(level[1] || 0);
      askDepthUsd += price * qty;
    }
  }

  const spreadPct = bestBid > 0 && bestAsk > 0
    ? ((bestAsk - bestBid) / bestBid) * 100
    : 0;

  const volume24hUsd = Number(ticker?.turnover24h || ticker?.volume24hUsd || 0);
  const lastPrice = Number(ticker?.lastPrice || ticker?.last || 0);

  return {
    symbol,
    lastPrice,
    volume24hUsd,
    spreadPct,
    bestBid,
    bestAsk,
    bidDepthUsd,
    askDepthUsd,
    topOfBookDepthUsd: Math.min(bidDepthUsd, askDepthUsd),
    fundingRate: Number(funding?.fundingRate || 0),
    fundingTime: funding?.fundingTime || null
  };
}

function liquidityScoreFromMarketData(marketData, accountEquityUsd = 10000, targetPositionFrac = 0.01) {
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

async function evaluateLiquidityGate(symbol, accountEquityUsd = 10000, targetPositionFrac = 0.01) {
  const md = await buildMarketData(symbol);
  const score = liquidityScoreFromMarketData(md, accountEquityUsd, targetPositionFrac);

  const targetUsd = Number(accountEquityUsd || 0) * Number(targetPositionFrac || 0.01);
  const valid =
    Number(md?.spreadPct || 0) <= Number(config.SPREAD_PERCENT || 0.05)
    && Number(md?.topOfBookDepthUsd || 0) >= targetUsd
    && Number(md?.volume24hUsd || 0) >= targetUsd * 2;

  return {
    valid,
    score,
    marketData: md
  };
}

module.exports = {
  buildMarketData,
  liquidityScoreFromMarketData,
  evaluateLiquidityGate
};