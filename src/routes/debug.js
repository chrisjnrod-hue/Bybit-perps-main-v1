const express = require('express');
const config = require('../config');
const { getTradingViewRating } = require('../services/tradingviewRating');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'debug route active',
    tradingViewEnabled: config.TRADINGVIEW_RATING_ENABLED,
    tradingViewInterval: config.TRADINGVIEW_RATING_INTERVAL
  });
});

router.get('/tv-rating', async (req, res) => {
  const symbol = String(req.query.symbol || 'BTCUSDT').trim().toUpperCase();
  const rating = await getTradingViewRating(symbol);
  res.json({
    ok: true,
    symbol,
    enabled: config.TRADINGVIEW_RATING_ENABLED,
    interval: config.TRADINGVIEW_RATING_INTERVAL,
    rating
  });
});

module.exports = router;
