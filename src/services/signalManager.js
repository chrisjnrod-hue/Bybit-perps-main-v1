const config = require('../config');
const { getMtfState, setMtfState, recordSignal } = require('../db');
const { evaluateMtfAlignment } = require('./mtfAlignment');
const { sma } = require('./ma');
const {
  macdHistogram,
  detectBullishHistogramFlip
} = require('./macd');
const { calculateCustomRating } = require('./customRatingEngine');
const { getTradingViewRating } = require('./tradingviewRating');
const { checkLiquidity } = require('./liquidityGuard');

function getCurrentPrice(ticker, latestDailyCandle) {
  const tickerPrice = Number(ticker?.lastPrice || ticker?.last || 0);
  if (tickerPrice > 0) return tickerPrice;

  return Number(latestDailyCandle?.close || latestDailyCandle?.open || 0);
}

async function evaluateSignal(symbol, candlesByTf = {}, ticker = {}) {
  const daily = Array.isArray(candlesByTf.D) ? candlesByTf.D : [];

  if (daily.length < 26) return null;

  const latestDailyCandle = daily[daily.length - 1];
  const currentPrice = getCurrentPrice(ticker, latestDailyCandle);
  const currentOpen = Number(latestDailyCandle?.open || 0);

  // Compare the current open/current price against the 7-period average
  // of the latest daily closes.
  const dailyCloses = daily.map((candle) => Number(candle.close || 0));
  const ma7 = sma(dailyCloses, 7);

  const openAboveMa7 = currentOpen > 0 && currentOpen > ma7;
  const priceAboveMa7 = currentPrice > 0 && currentPrice > ma7;
  const aboveMa7 = openAboveMa7 || priceAboveMa7;

  // The latest candle is treated as the current/open candle. The previous
  // histogram value is from the prior, closed candle.
  const dailyHistogram = macdHistogram(daily);
  const dailyHistogramDirection =
    dailyHistogram > 0 ? 'bullish' : dailyHistogram < 0 ? 'negative' : 'neutral';
  const macdFlip = detectBullishHistogramFlip(daily);

  // 1D root candidate:
  // - open or price above 7MA, regardless of histogram direction; OR
  // - below 7MA with a current positive MACD histogram flip.
  const dailyRootSignal = aboveMa7 || (!aboveMa7 && macdFlip);

  if (!dailyRootSignal) return null;

  const mtf = evaluateMtfAlignment(
    {
      '5': candlesByTf['5'] || [],
      '15': candlesByTf['15'] || [],
      '60': candlesByTf['60'] || [],
      '240': candlesByTf['240'] || []
    },
    dailyHistogramDirection
  );

  const liquidity = checkLiquidity(
    {
      volume24hUsd: Number(
        ticker?.volume24hUsd || ticker?.turnover24h || 0
      ),
      spreadPct: Number(ticker?.spreadPct || 0),
      topOfBookDepthUsd: Number(ticker?.topOfBookDepthUsd || 0)
    },
    Number(config.DEFAULT_ACCOUNT_EQUITY_USD || 10000),
    Number(config.TARGET_POSITION_FRAC || 0.01)
  );

  const score = calculateCustomRating({
    macdFlip,
    openAboveMa7: aboveMa7,
    mtfStatus: mtf.status,
    liquidityValid: liquidity.valid,
    marketTrend: mtf.alignedWithDaily ? 'strong' : 'mixed',
    priceBelow14Ma: false
  });

  const tv = await getTradingViewRating(symbol);
  const previousState = await getMtfState(symbol, 'D');

  // Keep the 1D candidate under monitoring until all four MTF MACD
  // directions match the current 1D histogram direction.
  const decision = mtf.alignedWithDaily ? 'accept' : 'monitor';

  let reason;
  if (aboveMa7 && macdFlip) {
    reason = '1D open/price above 7MA and positive MACD histogram flip';
  } else if (aboveMa7) {
    reason = `1D open/price above 7MA; histogram ${dailyHistogramDirection}`;
  } else {
    reason = '1D below 7MA with current positive MACD histogram flip';
  }

  const signal = {
    symbol,
    timeframe: 'D',
    dailyCandleTime: Number(latestDailyCandle?.open_time || 0) || null,
    decision,
    reason,
    macdFlip,
    dailyHistogram,
    dailyHistogramDirection,
    openAboveMa7,
    priceAboveMa7,
    customScore: score.score,
    customScoreLabel: score.label,
    tvScore: tv.score,
    tvScoreLabel: tv.label,
    mtfStatus: mtf.status,
    mtfValues: mtf.values,
    mtfAligned: mtf.alignedWithDaily,
    mtfAlignedWithDaily: mtf.alignedWithDaily,
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
  evaluateSignal
};
