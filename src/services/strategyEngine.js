const config = require('../config');
const axios = require('axios');
const { fetchAllSymbols, fetchKlines, fetchTicker } = require('./bybitRest');
const bybitWs = require('./bybitWs');
const {
  upsertSymbol,
  saveKlines,
  getLatestCandles,
  listOpenTrades,
  saveKline,
  query
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

// Prune stale klines / data older than 24h before new 1D candle boundary
async function performDailyCleanup() {
  try {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    await query(`DELETE FROM klines WHERE open_time < $1 AND timeframe != 'D'`, [cutoff]);
    console.log('Daily cache cleanup completed successfully.');
  } catch (err) {
    console.error('Daily cleanup failed:', err.message);
  }
}

// Keep-alive ping handler
function setupKeepAlive() {
  if (!config.ENABLE_KEEPALIVE_PING || !config.KEEPALIVE_URL) return;
  setInterval(async () => {
    try {
      await axios.get(config.KEEPALIVE_URL);
      console.log('Keep-alive ping sent successfully.');
    } catch (err) {
      console.error('Keep-alive ping failed:', err.message);
    }
  }, config.KEEPALIVE_INTERVAL_MS || 300000);
}

async function evaluateAndSendBoundary(symbol) {
  const byTf = {};
  for (const tf of ['5', '15', '60', '240', 'D']) {
    byTf[tf] = await getLatestCandles(symbol, tf, 200);
  }

  const ticker = await fetchTicker(symbol);
  const marketData = await buildMarketData(symbol);
  const signal = await evaluateSignal(symbol, byTf, { ...ticker, ...marketData });

  if (!signal) return null;

  await sendTelegramMessage(formatSignalBlock({
    symbol: signal.symbol,
    time: new Date().toISOString(),
    decision: signal.decision,
    reason: signal.reason,
    customScore: signal.customScore,
    tvScore: signal.tvScore,
    mtfStatus: signal.mtfStatus,
    mtfValues: signal.mtfValues,
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

async function bootstrapStrategy() {
  console.log('Bootstrapping strategy');
  setupKeepAlive();

  const symbols = await seedSymbols();
  if (!symbols.length) {
    console.log('No symbols loaded');
    return;
  }

  setInterval(performDailyCleanup, 24 * 60 * 60 * 1000);

  if (config.USE_WS) {
    bybitWs.connect();

    bybitWs.on('kline', async (msg) => {
      const topic = msg?.topic || '';
      const symbol = String(topic).split('.').slice(2).join('.');
      const tf = String(topic).split('.')[1] || 'D';

      const candle = normalizeWsCandle(msg);
      if (!candle || !symbol || !tf) return;

      await saveKline(symbol, tf, candle);

      if (tf === 'D') {
        try {
          await performDailyCleanup();
          await evaluateAndSendBoundary(symbol);
          await syncOpenTradesFromMarket();
        } catch (err) {
          console.error('WS boundary evaluation failed for', symbol, err.message);
        }
      }
    });

    if (!wsBootstrapped) {
      bybitWs.subscribe(symbols, ['5', '15', '60', '240', 'D']);
      wsBootstrapped = true;
    }
  }

  // --- INITIAL 1D CANDLE OPEN SCAN (FULL A-Z) ---
  const allSignals = [];
  const maxTrades = Number(config.MAX_OPEN_TRADES || 3);
  let recommendedCount = 0;

  console.log(`Starting full A-Z scan across ${symbols.length} symbols...`);

  for (const symbol of symbols) {
    try {
      // Add a 100ms throttle delay to avoid Bybit HTTP 400 rate limits
      await new Promise(r => setTimeout(r, 100));

      const candleMap = await fetchCandlesForSymbol(symbol);
      const ticker = await fetchTicker(symbol);
      const marketData = await buildMarketData(symbol);
      const signal = await evaluateSignal(symbol, candleMap, { ...ticker, ...marketData });
      
      if (signal) {
        allSignals.push(signal);

        await sendTelegramMessage(formatSignalBlock({
          symbol: signal.symbol,
          time: new Date().toISOString(),
          decision: signal.decision,
          reason: signal.reason,
          customScore: signal.customScore,
          tvScore: signal.tvScore,
          mtfStatus: signal.mtfStatus,
          mtfValues: signal.mtfValues,
          price: signal.price,
          volume24h: Number(marketData.volume24hUsd || 0),
          spreadPct: Number(marketData.spreadPct || 0),
          liquidity: 'valid',
          trailingStop: 'higher_lows or close below 14MA',
          takeProfit: '3%',
          action: signal.decision === 'accept' ? 'open' : 'monitor'
        }));

        if (signal.decision === 'accept' && recommendedCount < maxTrades) {
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
            recommendedCount++;

            await sendTelegramMessage(formatRecommendationTelegram({
              symbol,
              action: 'open',
              customScore: signal.customScore,
              tvScore: signal.tvScore,
              mtfStatus: signal.mtfStatus,
              mtfValues: signal.mtfValues,
              liquidity: 'valid',
              reason: signal.reason,
              plan
            }));
          }
        }
      }
    } catch (err) {
      console.error(`Initial scan failed for ${symbol}:`, err.message);
    }
  }

  if (allSignals.length) {
    await sendTelegramMessage(formatSummaryTelegram(allSignals));
  }

  // --- BOUNDARY / PERIODIC FOLLOW-UP SCAN (NEW SIGNALS ONLY) ---
  setInterval(async () => {
    try {
      const activeSymbols = await seedSymbols();

      for (const symbol of activeSymbols) {
        await new Promise(r => setTimeout(r, 100));

        const byTf = {};
        for (const tf of ['5', '15', '60', '240', 'D']) {
          byTf[tf] = await getLatestCandles(symbol, tf, 200);
        }

        const ticker = await fetchTicker(symbol);
        const marketData = await buildMarketData(symbol);
        const signal = await evaluateSignal(symbol, byTf, { ...ticker, ...marketData });

        if (!signal || signal.decision !== 'accept') continue;

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

          await sendTelegramMessage(formatSignalBlock({
            symbol: signal.symbol,
            time: new Date().toISOString(),
            decision: signal.decision,
            reason: signal.reason,
            customScore: signal.customScore,
            tvScore: signal.tvScore,
            mtfStatus: signal.mtfStatus,
            mtfValues: signal.mtfValues,
            price: signal.price,
            volume24h: Number(marketData.volume24hUsd || 0),
            spreadPct: Number(marketData.spreadPct || 0),
            liquidity: 'valid',
            trailingStop: 'higher_lows or close below 14MA',
            takeProfit: '3%',
            action: 'open'
          }));
        }
      }

      await syncOpenTradesFromMarket();
    } catch (err) {
      console.error('Periodic boundary scan failed:', err.message);
    }
  }, 15000);
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

module.exports = {
  bootstrapStrategy
};
