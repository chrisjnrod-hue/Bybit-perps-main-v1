const config = require('../config');
const { fetchAllSymbols, fetchKlines, fetchTicker } = require('./bybitRest');
const bybitWs = require('./bybitWs');
const {
  upsertSymbol,
  saveKlines,
  getLatestCandles,
  listOpenTrades,
  saveKline,
  recordSignal
} = require('../db');
const { filterUsdtPerpetualSymbols } = require('./symbolScanner');
const { evaluateSignal } = require('./signalManager');
const { shouldOpenTrade, buildTradePlan } = require('./tradeManager');
const { ensureTradeFromSignal, updateTradeFromMarket } = require('./openTradeTracker');
const { sendTelegramMessage } = require('./telegram');
const { formatSummaryTelegram, formatRecommendationTelegram, formatSignalBlock } = require('./telegramFormatter');
const { buildMarketData } = require('./marketData');

let wsBootstrapped = false;

async function seedSymbols() {
  const symbols = await fetchAllSymbols();
  const filtered = filterUsdtPerpetualSymbols(symbols);

  for (const symbol of filtered) {
    const base = symbol.replace(/USDT(\.P)?$/i, '');
    await upsertSymbol(symbol, base, 'USDT', 'active');
  }

  return filtered;
}

async function fetchCandlesForSymbol(symbol) {
  const timeframes = ['5', '15', '60', '240', 'D'];
  const byTf = {};

  for (const tf of timeframes) {
    const candles = await fetchKlines(symbol, tf, 200);
    await saveKlines(symbol, tf, candles);
    byTf[tf] = candles;
  }

  return byTf;
}

function normalizeWsCandle(payload) {
  if (!payload) return null;

  const kline = payload?.data?.[0] || payload?.data || payload;
  if (!kline) return null;

  return {
    open_time: Number(kline.start || kline.t || kline.open_time || 0),
    open: Number(kline.open || kline.o || 0),
    high: Number(kline.high || kline.h || 0),
    low: Number(kline.low || kline.l || 0),
    close: Number(kline.close || kline.c || 0),
    volume: Number(kline.volume || kline.v || 0)
  };
}

async function evaluateAndSend(symbol) {
  const byTf = {};
  for (const tf of ['5', '15', '60', '240', 'D']) {
    byTf[tf] = await getLatestCandles(symbol, tf, 200);
  }

  const ticker = await fetchTicker(symbol);
  const marketData = await buildMarketData(symbol);

  const signal = await evaluateSignal(symbol, byTf, { ...ticker, ...marketData });

  if (!signal) return null;

  // Save the evaluated signal to PostgreSQL
  await recordSignal(signal);

  const tradeCheck = shouldOpenTrade(signal, {
    volume24hUsd: Number(marketData.volume24hUsd || 0),
    spreadPct: Number(marketData.spreadPct || 0),
    topOfBookDepthUsd: Number(marketData.topOfBookDepthUsd || 0)
  });

  if (signal.decision === 'accept' && tradeCheck.open) {
    const plan = buildTradePlan(signal, {
      volume24hUsd: Number(marketData.volume24hUsd || 0),
      spreadPct: Number(marketData.spreadPct || 0),
      topOfBookDepthUsd: Number(marketData.topOfBookDepthUsd || 0)
    });

    ensureTradeFromSignal(signal, plan);

    await sendTelegramMessage(formatRecommendationTelegram({
      symbol,
      action: 'open',
      customScore: signal.customScore,
      tvScore: signal.tvScore,
      mtfStatus: signal.mtfStatus,
      liquidity: 'valid',
      reason: signal.reason,
      plan
    }));
  }

  await sendTelegramMessage(formatSignalBlock({
    symbol: signal.symbol,
    time: new Date().toISOString(),
    decision: signal.decision,
    reason: signal.reason,
    customScore: signal.customScore,
    tvScore: signal.tvScore,
    mtfStatus: signal.mtfStatus,
    price: signal.price,
    volume24h: Number(marketData.volume24hUsd || 0),
    spreadPct: Number(marketData.spreadPct || 0),
    liquidity: 'valid',
    trailingStop: 'higher_lows or close below 14MA',
    takeProfit: '3%',
    action: signal.decision === 'accept' ? 'open' : 'monitor'
  }));

  return signal;
}

async function syncOpenTradesFromMarket() {
  const openTrades = await listOpenTrades();

  for (const trade of openTrades) {
    const candles = {};
    for (const tf of ['5', '15', '60', '240', 'D']) {
      candles[tf] = await getLatestCandles(trade.symbol, tf, 200);
    }

    const marketData = await buildMarketData(trade.symbol);
    const currentPrice = Number(marketData.lastPrice || 0);

    if (!currentPrice) continue;

    updateTradeFromMarket(trade.symbol, currentPrice, candles.D || []);
  }
}

async function bootstrapStrategy() {
  console.log('Bootstrapping strategy');

  const symbols = await seedSymbols();
  if (!symbols.length) {
    console.log('No symbols loaded');
    return;
  }

  if (config.USE_WS) {
    bybitWs.connect();

    bybitWs.on('kline', async (msg) => {
      const topic = msg?.topic || '';
      const symbol = String(topic).split('.').slice(2).join('.');
      const tf = String(topic).split('.')[1] || 'D';

      const candle = normalizeWsCandle(msg);
      if (!candle || !symbol || !tf) return;

      const normalized = {
        open_time: candle.open_time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
      };

      await saveKline(symbol, tf, normalized);

      if (tf === 'D') {
        try {
          await evaluateAndSend(symbol);
          await syncOpenTradesFromMarket();
        } catch (err) {
          console.error('WS evaluation failed for', symbol, err.message);
        }
      }
    });

    if (!wsBootstrapped) {
      bybitWs.subscribe(symbols.slice(0, 50), ['5', '15', '60', '240', 'D']);
      wsBootstrapped = true;
    }
  }

  const allSignals = [];

  for (const symbol of symbols.slice(0, 30)) {
    try {
      const candleMap = await fetchCandlesForSymbol(symbol);
      const ticker = await fetchTicker(symbol);
      const marketData = await buildMarketData(symbol);
      const signal = await evaluateSignal(symbol, candleMap, { ...ticker, ...marketData });
      if (signal) {
        await recordSignal(signal); // Save initial scan signals to DB
        allSignals.push(signal);
      }
    } catch (err) {
      console.error(`Initial scan failed for ${symbol}:`, err.message);
    }
  }

  if (allSignals.length) {
    await sendTelegramMessage(formatSummaryTelegram(allSignals));
  }

  setInterval(async () => {
    try {
      const activeSymbols = (await fetchAllSymbols()).slice(0, 40);

      for (const item of activeSymbols) {
        const symbol = item.symbol;

        const byTf = {};
        for (const tf of ['5', '15', '60', '240', 'D']) {
          byTf[tf] = await getLatestCandles(symbol, tf, 200);
        }

        const ticker = await fetchTicker(symbol);
        const marketData = await buildMarketData(symbol);
        const signal = await evaluateSignal(symbol, byTf, { ...ticker, ...marketData });

        if (!signal) continue;

        await recordSignal(signal); // Save periodic scan signals to DB

        if (signal.decision === 'accept') {
          const tradeCheck = shouldOpenTrade(signal, {
            volume24hUsd: Number(marketData.volume24hUsd || 0),
            spreadPct: Number(marketData.spreadPct || 0),
            topOfBookDepthUsd: Number(marketData.topOfBookDepthUsd || 0)
          });

          if (tradeCheck.open) {
            const plan = buildTradePlan(signal, {
              volume24hUsd: Number(marketData.volume24hUsd || 0),
              spreadPct: Number(marketData.spreadPct || 0),
              topOfBookDepthUsd: Number(marketData.topOfBookDepthUsd || 0)
            });

            ensureTradeFromSignal(signal, plan);

            await sendTelegramMessage(formatRecommendationTelegram({
              symbol,
              action: 'open',
              customScore: signal.customScore,
              tvScore: signal.tvScore,
              mtfStatus: signal.mtfStatus,
              liquidity: 'valid',
              reason: signal.reason
            }));
          }
        }
      }

      await syncOpenTradesFromMarket();
    } catch (err) {
      console.error('Periodic scan failed:', err.message);
    }
  }, 15000);
}

module.exports = {
  bootstrapStrategy
};
