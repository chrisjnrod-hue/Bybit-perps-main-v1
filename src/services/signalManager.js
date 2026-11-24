const config = require('../config');
const { getMtfState, setMtfState, recordSignal } = require('../db');
const { evaluateMtfAlignment } = require('./mtfAlignment');
const { sma } = require('./ma');
const { macdSeries, macdHistogram } = require('./macd');
const { calculateCustomRating } = require('./customRatingEngine');
const { getTradingViewRating } = require('./tradingviewRating');
const {
  checkLiquidity,
  getAccountEquity,
  CONFIG: liquidityConfig
} = require('./liquidityGuard');

function getCurrentPrice(ticker, latestDailyCandle) {
  const tickerPrice = Number(ticker?.lastPrice || ticker?.last || 0);
  if (tickerPrice > 0) return tickerPrice;

  return Number(latestDailyCandle?.close || latestDailyCandle?.open || 0);
}

function detectStrictBullishDailyFlip(daily = []) {
  if (!Array.isArray(daily) || daily.length < 27) return false;
  const { histogram } = macdSeries(daily);
  if (histogram.length < 2) return false;

  const prev = histogram[histogram.length - 2];
  const curr = histogram[histogram.length - 1];

  return Number.isFinite(prev) && Number.isFinite(curr) && prev < 0 && curr > 0;
}

function evaluateDailyRootCriteria(daily = [], ticker = {}) {
  if (!Array.isArray(daily) || daily.length < 8) return null;

  const latest = daily[daily.length - 1];
  const currentOpen = Number(latest?.open || 0);
  const currentPrice = getCurrentPrice(ticker, latest);
  const recentCloses = daily
    .slice(-8, -1)
    .map((candle) => Number(candle.close || 0));

  if (recentCloses.length < 7 || currentOpen <= 0 || currentPrice <= 0) {
    return null;
  }

  const ma7 = sma(recentCloses, 7);
  const openAndPriceAboveMa7 = currentOpen > ma7 && currentPrice > ma7;
  const positiveFlip = detectStrictBullishDailyFlip(daily);

  if (!openAndPriceAboveMa7 && !positiveFlip) return null;

  let reason = '1D open-candle histogram flipped positive after prior closed candle was negative';
  if (openAndPriceAboveMa7 && positiveFlip) {
    reason = '1D open and current price above 7MA with positive hist flip';
  } else if (openAndPriceAboveMa7) {
    reason = '1D open and current price above 7MA';
  }

  return {
    symbol: ticker.symbol || null,
    dailyCandleTime: Number(latest?.open_time || 0) || null,
    currentOpen,
    currentPrice,
    ma7,
    openAndPriceAboveMa7,
    positiveFlip,
    reason
  };
}

function detectDailyRootSignal(daily = [], ticker = {}) {
  return evaluateDailyRootCriteria(
