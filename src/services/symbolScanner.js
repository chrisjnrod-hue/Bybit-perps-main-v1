function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function getBaseAsset(symbol) {
  return normalizeSymbol(symbol).replace(/USDT(?:\.P)?$/, '');
}

const STABLECOIN_BASES = new Set([
  'DAI',
  'FDUSD',
  'GUSD',
  'PYUSD',
  'TUSD',
  'USDC',
  'USDD',
  'USDE',
  'USDP',
  'USDS',
  'USDT',
  'USD1',
  'USTC'
]);

function isStablecoinSymbol(symbol) {
  return STABLECOIN_BASES.has(getBaseAsset(symbol));
}

function filterUsdtPerpetualSymbols(symbols) {
  return (symbols || [])
    .filter((item) => {
      if (!item || !item.symbol) return false;

      const symbol = normalizeSymbol(item.symbol);

      // only linear USDT perpetuals
      if (!/^[A-Z0-9]+USDT(?:\.P)?$/.test(symbol)) return false;

      const contractType = String(item.contractType || '').trim().toUpperCase();
      if (contractType && contractType !== 'LINEARPERPETUAL') {
        return false;
      }

      // reject inverse or weird suffix patterns
      if (/-[0-9]{2}[A-Z]{3}[0-9]{2}$/.test(symbol)) return false;

      // only stablecoins are excluded
      if (isStablecoinSymbol(symbol)) return false;

      return true;
    })
    .map((item) => normalizeSymbol(item.symbol));
}

module.exports = {
  filterUsdtPerpetualSymbols
};
