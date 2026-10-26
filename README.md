# Bybit Strategy Bot

A Node 18 + SQLite trading signal bot for Bybit perpetual market scanning.

Features
- WS-first live market feed with REST fallback
- Bybit perpetual symbol discovery
- Daily 1D signal evaluation
- MTF alignment checks
- internal custom score engine
- secondary TradingView score support
- Telegram summary + recommendation + signal blocks
- live order book liquidity gate
- trailing stop + open trade tracking

Project structure
```text
.
├── .env.example
├── .nvmrc
├── package.json
├── src
│   ├── config.js
│   ├── db.js
│   ├── index.js
│   ├── data
│   │   └── .gitkeep
│   ├── routes
│   │   ├── .gitkeep
│   │   └── debug.js
│   └── services
│       ├── .gitkeep
│       ├── bybitRest.js
│       ├── bybitWs.js
│       ├── customRatingEngine.js
│       ├── liquidityGuard.js
│       ├── ma.js
│       ├── macd.js
│       ├── marketData.js
│       ├── mtfAlignment.js
│       ├── openTradeTracker.js
│       ├── signalManager.js
│       ├── strategyEngine.js
│       ├── symbolScanner.js
│       ├── telegram.js
│       ├── telegramFormatter.js
│       ├── tradeManager.js
│       ├── trailingStopEngine.js
│       └── tradingviewRating.js
