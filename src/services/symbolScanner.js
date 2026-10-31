const config = require('../config');

function filterUsdtPerpetualSymbols(symbols) {
  return (symbols || [])
    .filter((item) => {
      if (!item || !item.symbol) return false;
      const symbol = String(item.symbol).toUpperCase();

      // Must end with USDT or USDT.P
      if (!/USDT(\.P)?$/.test(symbol)) return false;

      // Verify contract type is Linear Perpetual if available
      if (item.contractType && item.contractType !== 'LinearPerpetual') {
        return false;
      }

      // Exclude dated/quarterly delivery contracts
      if (/-[0-9]{2}[A-Z]{3}[0-9]{2}$/.test(symbol) || /[0-9]{2}[A-Z]{3}[0-9]{2}/.test(symbol)) {
        return false;
      }

      // Exclude tokens starting with digits (multipliers/leveraged tokens, e.g. 10000NEXUSDT)[cite: 1]
      if (/^[0-9]/.test(symbol)) return false;

      // Exclude stock perpetuals and equity tickers[cite: 3]
      const stockSymbols = ['AALUSDT', 'AAOIUSDT', 'TSLAUSDT', 'NVDAUSDT', 'AAPLUSDT', 'MSFTUSDT'];
      if (stockSymbols.includes(symbol)) {
        return false;
      }

      return new RegExp(config.SYMBOL_FILTER).test(symbol);
    })
    .map((item) => item.symbol);
}

module.exports = {
  filterUsdtPerpetualSymbols
};
```[cite: 6]
