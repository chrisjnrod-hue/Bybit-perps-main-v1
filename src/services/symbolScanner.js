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
    return true;
  }
}

function filterUsdtPerpetualSymbols(symbols) {
  return (symbols || [])
    .filter((item) => {
      if (!item || !item.symbol) return false;

      const symbol = normalizeSymbol(item.symbol);

      // ALLOW numeric prefixes e.g. 10000NEXUSDT
      if (!/^[A-Z0-9]+USDT(\.P)?$/.test(symbol)) return false;

      const contractType = String(item.contractType || '').trim().toUpperCase();

      if (contractType && contractType !== 'LINEARPERPETUAL') {
        return false;
      }

      if (/-[0-9]{2}[A-Z]{3}[0-9]{2}$/.test(symbol)) return false;

      if (['AALUSDT', 'AAOIUSDT', 'TSLAUSDT', 'NVDAUSDT', 'AAPLUSDT', 'MSFTUSDT'].includes(symbol)) {
        return false;
      }

      return isValidSymbolPattern(symbol);
    })
    .map((item) => normalizeSymbol(item.symbol));
}

module.exports = {
  filterUsdtPerpetualSymbols
};
