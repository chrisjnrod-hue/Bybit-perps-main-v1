const config = require('../config');

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function isValidSymbolPattern(symbol) {
  const pattern = config.SYMBOL_FILTER || '.*';
  try {
    return new RegExp(pattern, 'i').test(symbol);
  } catch (err) {
    console.warn('Invalid SYMBOL_FILTER regex:', pattern, err.message);
    return true; // safe fallback: accept all instead of crashing
  }
}

function filterUsdtPerpetualSymbols(symbols) {
  return (symbols || [])
    .filter((item) => {
      if (!item || !item.symbol) return false;

      const symbol = normalizeSymbol(item.symbol);

      // Accept common Bybit perpetual symbol formats
      if (!/^(?!\d)[A-Z0-9]+USDT(\.P)?$/.test(symbol)) return false;

      const contractType = String(item.contractType || '').trim().toUpperCase();

      if (contractType && !['LINEARPERPETUAL'].includes(contractType)) {
        return false;
      }

      // Exclude dated contracts
      if (/-[0-9]{2}[A-Z]{3}[0-9]{2}$/.test(symbol)) return false;

      // Exclude stock/equity tickers and weird multipliers
      if (/^[0-9]/.test(symbol)) return false;

      const stockSymbols = new Set([
        'AALUSDT', 'AAOIUSDT', 'TSLAUSDT', 'NVDAUSDT', 'AAPLUSDT', 'MSFTUSDT'
      ]);
      if (stockSymbols.has(symbol)) return false;

      return isValidSymbolPattern(symbol);
    })
    .map((item) => normalizeSymbol(item.symbol));
}

module.exports = {
  filterUsdtPerpetualSymbols
};
