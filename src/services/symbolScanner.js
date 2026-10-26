const config = require('../config');

function filterUsdtPerpetualSymbols(symbols) {
  return (symbols || [])
    .filter((item) => {
      if (!item || !item.symbol) return false;
      const symbol = String(item.symbol).toUpperCase();
      if (!/USDT(\.P)?$/.test(symbol)) return false;
      if (/USDT[QHUZ0-9]/.test(symbol.slice(-6))) return false;
      return new RegExp(config.SYMBOL_FILTER).test(symbol);
    })
    .map((item) => item.symbol);
}

module.exports = {
  filterUsdtPerpetualSymbols
};
