const config = require('../config');

function getMinimumTvScore() {
  // MIN_TV_SCORE is the native TradingView -1..1 rating threshold.
  // MIN_TV_RATING is kept as a backwards-compatible fallback.
  return Number(config.MIN_TV_SCORE ?? config.MIN_TV_RATING ?? 0.6);
}

function getMinimumCustomScore() {
  return Number(config.MIN_CUSTOM_SCORE ?? 65);
}

function shouldOpenTrade(signal, market) {
  if (!signal || signal.decision !== 'accept') {
    return { open: false, reason: 'signal not accepted' };
  }

  if (
    signal.tvScoreAvailable !== true ||
    signal.tvScore === null ||
    signal.tvScore === undefined ||
    !Number.isFinite(Number(signal.tvScore))
  ) {
    return {
      open: false,
      reason: 'TradingView technical rating unavailable'
    };
  }

  const tvScore = Number(signal.tvScore);
  const customScore = Number(signal.customScore);
  const minTvScore = getMinimumTvScore();
  const minCustomScore = getMinimumCustomScore();

  if (tvScore < minTvScore) {
    return {
      open: false,
      reason: `TradingView score ${tvScore.toFixed(2)} is below minimum ${minTvScore}`
    };
  }

  if (!Number.isFinite(customScore) || customScore < minCustomScore) {
    return {
      open: false,
      reason: `Custom score ${Number.isFinite(customScore) ? customScore : 'N/A'} is below minimum ${minCustomScore}`
    };
  }

  const volume24hUsd = Number(market?.volume24hUsd || 0);
  const spreadPct = Number(market?.spreadPct ?? 0.02);
  const topOfBookDepthUsd = Number(market?.topOfBookDepthUsd || 0);

  if (volume24hUsd <= 0) {
    return { open: false, reason: 'no volume' };
  }

  if (spreadPct > 0.2) {
    return { open: false, reason: 'spread too high' };
  }

  if (topOfBookDepthUsd <= 0) {
    return { open: false, reason: 'depth too low' };
  }

  return {
    open: true,
    reason: 'meets TradingView, custom-score, and risk requirements'
  };
}

function rankTradeCandidates(candidates = []) {
  return [...candidates].sort((a, b) => {
    const aTv = Number(a?.signal?.tvScore);
    const bTv = Number(b?.signal?.tvScore);
    const tvDifference =
      (Number.isFinite(bTv) ? bTv : -Infinity) -
      (Number.isFinite(aTv) ? aTv : -Infinity);

    if (tvDifference !== 0) return tvDifference;

    const aCustom = Number(a?.signal?.customScore);
    const bCustom = Number(b?.signal?.customScore);
    const customDifference =
      (Number.isFinite(bCustom) ? bCustom : -Infinity) -
      (Number.isFinite(aCustom) ? aCustom : -Infinity);

    if (customDifference !== 0) return customDifference;

    return String(a?.signal?.symbol || '').localeCompare(
      String(b?.signal?.symbol || '')
    );
  });
}

function buildTradePlan(signal, market) {
  const price = Number(signal?.price || 0);
  const spreadPct = Number(market?.spreadPct ?? 0.02);

  const stopLoss =
    price * (Number(config.DEFAULT_SL_PERCENT || 1.5) / 100);
  const takeProfit =
    price * (Number(config.DEFAULT_TP_PERCENT || 3) / 100);

  return {
    symbol: signal.symbol,
    side: 'long',
    price,
    stopLoss: Number(stopLoss.toFixed(8)),
    takeProfit: Number(takeProfit.toFixed(8)),
    spreadPct,
    volume24hUsd: Number(market?.volume24hUsd || 0),
    topOfBookDepthUsd: Number(market?.topOfBookDepthUsd || 0),
    tvScore: Number(signal.tvScore),
    customScore: Number(signal.customScore)
  };
}

module.exports = {
  shouldOpenTrade,
  rankTradeCandidates,
  buildTradePlan
};
