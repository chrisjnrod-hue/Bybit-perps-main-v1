const { getMtfState, setMtfState, recordSignal } = require('../db');
const { evaluateMtfAlignment } = require('./mtfAlignment');
const { currentOpenAboveMA } = require('./ma');
const { detectBullishHistogramFlip } = require('./macd');
const { calculateCustomRating } = require('./customRatingEngine');
const { getTradingViewRating } = require('./tradingviewRating');
const { checkLiquidity } = require('./liquidityGuard');

async function evaluateSignal(symbol, candlesByTf, ticker) {
  const daily = candlesByTf.D || [];
  if (!daily.length) return null;

  const macdFlip = detectBullishHistogramFlip(daily);
  const above7ma = currentOpenAboveMA(daily, 7);

  if (!macdFlip && !above7ma) return null;

  const mtf = evaluateMtfAlignment({
    '5': candlesByTf['5'] || [],
    '15': candlesByTf['15'] || [],
    '60': candlesByTf['60'] || [],
    '240': candlesByTf['240'] || []
  });

  const liquidity = checkLiquidity(
    {
      volume24hUsd: Number(ticker?.turnover24h || ticker?.volume24hUsd || 0),
      spreadPct: Number(ticker?.spreadPct || 0.02),
      topOfBookDepthUsd: Number(ticker?.topOfBookDepthUsd || 0)
    },
    10000,
    0.01
  );

  const score = calculateCustomRating({
    macdFlip,
    openAboveMa7: above7ma,
    mtfStatus: mtf.status,
    liquidityValid: liquidity.valid,
    marketTrend: mtf.status === 'bullish' ? 'strong' : 'mixed',
    priceBelow14Ma: false
  });

  const tv = await getTradingViewRating(symbol);

  const previousState = getMtfState(symbol);
  const decision = score.score >= 65 && liquidity.valid ? 'accept' : 'monitor';

  const signal = {
    symbol,
    timeframe: 'D',
    decision,
    reason: macdFlip ? 'daily MACD flip' : 'open above 7MA',
    customScore: score.score,
    tvScore: tv.score,
    mtfStatus: mtf.status,
    status: decision === 'accept' ? 'new' : 'monitor',
    price: Number(daily[daily.length - 1]?.close || 0),
    liquidity,
    mtfTransition: previousState && previousState.state && previousState.state !== mtf.status
      ? `${previousState.state}->${mtf.status}`
      : 'stable'
  };

  setMtfState(symbol, 'D', mtf.status);
  recordSignal(signal);

  return signal;
}

module.exports = {
  evaluateSignal
};