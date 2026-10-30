const {
  listOpenTrades,
  saveOpenTrade,
  updateOpenTradeStatus,
  getOpenTradeBySymbol,
  countOpenTrades
} = require('../db');
const { evaluateTrailingStop } = require('./trailingStopEngine');

async function ensureTradeFromSignal(signal, plan) {
  const existing = await getOpenTradeBySymbol(signal.symbol);

  if (existing && existing.status === 'open') {
    return existing;
  }

  const trade = {
    symbol: signal.symbol,
    side: plan.side || 'long',
    entry_price: Number(plan.price || signal.price || 0),
    stop_loss: Number(plan.stopLoss || 0),
    take_profit: Number(plan.takeProfit || 0),
    trailing_stop: Number(plan.stopLoss || 0),
    status: 'open',
    score: Number(signal.customScore || 0)
  };

  const saved = await saveOpenTrade(trade);
  return saved;
}

async function updateTradeFromMarket(symbol, currentPrice, candles) {
  const trades = await listOpenTrades();
  const filtered = trades.filter((trade) => trade.symbol === symbol);

  for (const trade of filtered) {
    const result = evaluateTrailingStop({
      symbol,
      side: trade.side || 'long',
      entryPrice: Number(trade.entry_price || 0),
      stopLoss: Number(trade.stop_loss || 0),
      currentPrice,
      candles,
      trailingLookback: 3,
      hardMaPeriod: 14
    });

    if (result.shouldExit) {
      await updateOpenTradeStatus(symbol, 'closed');
      continue;
    }

    if (Number(result.stopLoss) > 0) {
      const tradeToSave = {
        ...trade,
        trailing_stop: Number(result.stopLoss),
        stop_loss: Number(result.stopLoss),
      };

      await saveOpenTrade(tradeToSave);
    }
  }
}

module.exports = {
  ensureTradeFromSignal,
  updateTradeFromMarket,
  countOpenTrades
};
