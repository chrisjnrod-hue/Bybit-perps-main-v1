/**
 * Checks if a single symbol meets liquidity thresholds.
 */
function checkLiquidity(symbolInfo = {}, accountEquityUsd = 10000, targetPositionFrac = 0.01) {
  const volume24hUsd = Number(symbolInfo.volume24hUsd || 0);
  const spreadPct = Number(symbolInfo.spreadPct || 0);
  const topOfBookDepthUsd = Number(symbolInfo.topOfBookDepthUsd || 0);
  const targetUsd = Number(accountEquityUsd || 0) * Number(targetPositionFrac || 0.01);

  if (spreadPct > 0.12) {
    return { valid: false, reason: 'spread_too_high' };
  }

  if (volume24hUsd < targetUsd * 2) {
    return { valid: false, reason: 'insufficient_24h_volume' };
  }

  if (topOfBookDepthUsd < targetUsd) {
    return { valid: false, reason: 'insufficient_depth' };
  }

  return { valid: true, reason: 'liquid' };
}

/**
 * Fetches all Bybit tickers for a given category and filters them for liquidity.
 * @param {string} category - 'linear', 'spot', or 'inverse'
 * @param {number} accountEquityUsd - Your account equity in USD
 * @param {number} targetPositionFrac - Target position size as a fraction of equity
 */
async function getLiquidSymbols(category = 'linear', accountEquityUsd = 10000, targetPositionFrac = 0.01) {
  const url = `https://bybit.com{category}`;
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }

  const data = await response.json();
  if (data.retCode !== 0) {
    throw new Error(`Bybit API error: ${data.retMsg}`);
  }

  const tickers = data.result.list || [];
  const results = [];

  for (const ticker of tickers) {
    // Only evaluate USDT pairs (optional: remove this check to include USDC/inverse pairs)
    if (!ticker.symbol.endsWith('USDT')) continue;

    const bidPrice = Number(ticker.bid1Price || 0);
    const askPrice = Number(ticker.ask1Price || 0);
    const bidSize = Number(ticker.bid1Size || 0);
    const askSize = Number(ticker.ask1Size || 0);
    const volume24hUsd = Number(ticker.turnover24h || 0);

    // Skip pairs with empty order books
    if (bidPrice <= 0 || askPrice <= 0) continue;

    // Calculate spread percentage and conservative top-of-book depth (weaker side in USD)
    const spreadPct = ((askPrice - bidPrice) / askPrice) * 100;
    const bidDepthUsd = bidPrice * bidSize;
    const askDepthUsd = askPrice * askSize;
    const topOfBookDepthUsd = Math.min(bidDepthUsd, askDepthUsd);

    const symbolInfo = {
      symbol: ticker.symbol,
      volume24hUsd,
      spreadPct,
      topOfBookDepthUsd
    };

    const status = checkLiquidity(symbolInfo, accountEquityUsd, targetPositionFrac);

    if (status.valid) {
      results.push({
        ...symbolInfo,
        ...status
      });
    }
  }

  return results;
}

// Automatically run if executed directly from the terminal (e.g., `node liquidity.js`)
if (require.main === module) {
  getLiquidSymbols('linear', 10000, 0.01)
    .then((liquidPairs) => {
      console.log(`Found ${liquidPairs.length} liquid USDT pairs:`);
      console.table(liquidPairs.slice(0, 10)); // Prints the first 10 matches
    })
    .catch((err) => console.error('Failed to fetch liquidity:', err.message));
}

module.exports = {
  checkLiquidity,
  getLiquidSymbols
};
