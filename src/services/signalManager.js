const config = require('../config');
const { getMtfState, setMtfState, recordSignal } = require('../db');
const { evaluateMtfAlignment } = require('./mtfAlignment');
const { sma } = require('./ma');
const { macdHistogram, detectBullishHistogramFlip } = require('./macd');
const { calculateCustomRating } = require('./customRatingEngine');
const { getTradingViewRating } = require('./tradingviewRating');
const { checkLiquidity } = require('./liquidityGuard');

function getCurrentPrice(ticker, latestDailyCandle) {
  const tickerPrice = Number(ticker?.lastPrice || ticker?.last || 0);
  if (tickerPrice > 0) return tickerPrice;

  return Number(latestDailyCandle?.close || latestDailyCandle?.open || 0);
}

function detectDailyRootSignal(daily = [], ticker = {}) {
  if (!Array.isArray(daily) || daily.length < 26) return null;

  const latest = daily[daily.length - 1];
  const currentOpen = Number(latest?.open || 0);
  const currentPrice = getCurrentPrice(ticker, latest);

  const priorCloses = daily
    .slice(0, -1)
    .map((candle) => Number(candle.close || 0));

  if (priorCloses.length < 7) return null;

  const ma7 = sma(priorCloses, 7);
  const openAboveMa7 = currentOpen > ma7;
  const priceAboveMa7 = currentPrice > ma7;
  const aboveMa7 = openAboveMa7 || priceAboveMa7;
  const positiveFlip = detectBullishHistogramFlip(daily);

  if (!aboveMa7 && !positiveFlip) return null;

  return {
    symbol: ticker.symbol || null,
    dailyCandleTime: Number(latest?.open_time || 0) || null,
    openAboveMa7,
    priceAboveMa7,
    positiveFlip,
    price: currentPrice,
    reason: aboveMa7
      ? '1D open/current price above 7MA'
      : '1D below 7MA with current positive histogram flip'
  };
}

async function evaluateSignal(symbol, candlesByTf = {}, ticker = {}) {
  const daily = Array.isArray(candlesByTf.D) ? candlesByTf.D : [];
  if (daily.length < 26) return null;

  const latestDailyCandle = daily[daily.length - 1];
  const currentPrice = getCurrentPrice(ticker, latestDailyCandle);
  const currentOpen = Number(latestDailyCandle?.open || 0);

  const dailyCloses = daily.map((candle) => Number(candle.close || 0));
  const ma7 = sma(dailyCloses, 7);

  const openAboveMa7 = currentOpen > ma7;
  const priceAboveMa7 = currentPrice > ma7;
  const aboveMa7 = openAboveMa7 || priceAboveMa7;

  const currentDailyHistogram = macdHistogram(daily);
  const dailyHistogramDirection =
    currentDailyHistogram > 0
      ? 'bullish'
      : currentDailyHistogram < 0
        ? 'negative'
        : 'neutral';

  const positiveFlip = detectBullishHistogramFlip(daily);

  const rootSignal = aboveMa7 || (!aboveMa7 && positiveFlip);

  if (!rootSignal) return null;

  const mtf = evaluateMtfAlignment({
    '5': candlesByTf['5'] || [],
    '15': candlesByTf['15'] || [],
    '60': candlesByTf['60'] || [],
    '240': candlesByTf['240'] || []
  });

  const liquidity = checkLiquidity(
    {
      volume24hUsd: Number(ticker?.volume24hUsd || ticker?.turnover24h || 0),
      spreadPct: Number(ticker?.spreadPct || 0),
      topOfBookDepthUsd: Number(ticker?.topOfBookDepthUsd || 0)
    },
    Number(config.DEFAULT_ACCOUNT_EQUITY_USD || 10000),
    Number(config.TARGET_POSITION_FRAC || 0.01)
  );

  const score = calculateCustomRating({
    macdFlip: positiveFlip,
    openAboveMa7: aboveMa7,
    mtfStatus: mtf.status,
    liquidityValid: liquidity.valid,
    marketTrend: mtf.aligned ? 'strong' : 'mixed',
    priceBelow14Ma: false
  });

  const tv = await getTradingViewRating(symbol);
  const previousState = await getMtfState(symbol, 'D');

  const decision =
    mtf.aligned && liquidity.valid
      ? 'accept'
      : 'monitor';

  let reason = '1D root signal';
  if (aboveMa7 && positiveFlip) {
    reason = '1D above 7MA and positive hist flip';
  } else if (aboveMa7) {
    reason = '1D above 7MA';
  } else if (positiveFlip) {
    reason = '1D below 7MA with positive hist flip';
  }

  const signal = {
    symbol,
    timeframe: 'D',
    dailyCandleTime: Number(latestDailyCandle?.open_time || 0) || null,
    decision,
    reason,
    dailyHistogram: currentDailyHistogram,
    dailyHistogramDirection,
    macdFlip: positiveFlip,
    openAboveMa7,
    priceAboveMa7,
    customScore: score.score,
    customScoreLabel: score.label,
    tvScore: tv.score,
    tvScoreLabel: tv.label,
    mtfStatus: mtf.status,
    mtfValues: mtf.values,
    mtfAligned: mtf.aligned,
    status: decision === 'accept' ? 'new' : 'monitor',
    price: currentPrice,
    liquidity,
    mtfTransition:
      previousState?.state && previousState.state !== mtf.status
        ? `${previousState.state}->${mtf.status}`
        : 'stable'
  };

  await setMtfState(symbol, 'D', mtf.status);
  await recordSignal(signal);

  return signal;
}

module.exports = {
  evaluateSignal,
  detectDailyRootSignal
};
