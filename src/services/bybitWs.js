// src/services/bybitWs.js
const WebSocket = require('ws');
const EventEmitter = require('events');
const config = require('../config');

const MAX_SUBSCRIBE_ARGS_PER_MESSAGE = 10;

class BybitWS extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.connected = false;
    this.url =
      config.BYBIT_WS_PUBLIC || 'wss://stream.bybit.com/v5/public/linear';

    this.subscribedTopics = new Set();
    this.tickerCache = new Map();
    this.orderBookCache = new Map();

    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.closedByUser = false;
    this.isReconnecting = false;
  }

  isEnabled() {
    return !!config.USE_WS;
  }

  connect() {
    if (!this.isEnabled()) {
      console.log('WS disabled by config');
      return null;
    }

    this.closedByUser = false;

    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return this.socket;
    }

    this.socket = new WebSocket(this.url);

    this.socket.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.isReconnecting = false;

      console.log('Bybit WS connected');
      this.emit('connected');

      this.sendSubscriptions();
      this.startPing();
    });

    this.socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());

        // Handle server ack / reject messages.
        if (message && typeof message === 'object' && message.op) {
          if (message.op === 'subscribe' || message.op === 'unsubscribe') {
            if (Number(message.retCode) !== 0) {
              console.warn('[Bybit WS]', {
                op: message.op,
                retCode: message.retCode,
                retMsg: message.retMsg,
                reqId: message.reqId || null
              });
            } else {
              // success; no noisy log
            }
          }
        }

        if (message?.topic) {
          this.handleMessage(message);
        }
      } catch (err) {
        console.error('WS message parse error:', err.message);
      }
    });

    this.socket.on('close', () => {
      this.connected = false;
      this.stopPing();
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    this.socket.on('error', (err) => {
      console.error('Bybit WS error:', err.message);
    });

    return this.socket;
  }

  disconnect() {
    this.closedByUser = true;
    this.stopPing();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }

    this.socket = null;
    this.connected = false;
  }

  startPing() {
    this.stopPing();

    this.pingTimer = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(JSON.stringify({ op: 'ping' }));
        } catch (err) {
          console.error('WS ping send failed:', err.message);
        }
      }
    }, 20000);
  }

  stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return;

    const maxAttempts = Number(config.WS_MAX_RECONNECT_ATTEMPTS || 8);
    if (this.reconnectAttempts >= maxAttempts) {
      console.error('Bybit WS reconnect limit reached.');
      return;
    }

    this.reconnectAttempts += 1;
    this.isReconnecting = true;

    const base = Number(config.WS_RECONNECT_DELAY_MS || 800);
    const factor = Number(config.WS_RECONNECT_BACKOFF_FACTOR || 2);
    const max = Number(config.WS_RECONNECT_MAX_MS || 24000);
    const wait = Math.min(
      max,
      base * factor ** (this.reconnectAttempts - 1)
    );

    console.warn(`[Bybit WS] reconnecting in ${wait}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  addTopic(topic) {
    if (!topic) return;
    this.subscribedTopics.add(topic);
  }

  subscribe(symbols, timeframes = ['5', '15', '60', '240', 'D']) {
    const list = Array.from(new Set(symbols || [])).filter(Boolean);

    for (const symbol of list) {
      this.addTopic(`tickers.${symbol}`);
      this.addTopic(`orderbook.50.${symbol}`);

      for (const timeframe of timeframes) {
        this.addTopic(`kline.${timeframe}.${symbol}`);
      }
    }

    this.sendSubscriptions();
  }

  sendSubscriptions() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    const topics = Array.from(this.subscribedTopics);
    if (!topics.length) return;

    for (let i = 0; i < topics.length; i += MAX_SUBSCRIBE_ARGS_PER_MESSAGE) {
      const chunk = topics.slice(i, i + MAX_SUBSCRIBE_ARGS_PER_MESSAGE);

      try {
        this.socket.send(
          JSON.stringify({
            op: 'subscribe',
            args: chunk
          })
        );
      } catch (err) {
        console.error('Failed to send WS subscription batch:', err.message);
      }
    }
  }

  handleMessage(msg) {
    const topic = String(msg?.topic || '');

    if (!topic) return;

    if (topic.startsWith('kline.')) {
      this.emit('kline', msg);
      return;
    }

    if (topic.startsWith('tickers.')) {
      const symbol = topic.slice('tickers.'.length);
      const incoming = Array.isArray(msg.data) ? msg.data[0] : msg.data;
      if (!symbol || !incoming) return;

      const previous = this.tickerCache.get(symbol)?.data || {};
      this.tickerCache.set(symbol, {
        data: { ...previous, ...incoming },
        updatedAt: Date.now()
      });
      this.emit('market', symbol);
      return;
    }

    if (topic.startsWith('orderbook.')) {
      const parts = topic.split('.');
      const symbol = parts.slice(2).join('.');
      if (!symbol || !msg.data) return;

      const book = this.orderBookCache.get(symbol) || {
        bids: new Map(),
        asks: new Map(),
        updatedAt: 0
      };

      const applyLevels = (target, levels, replace) => {
        if (replace) target.clear();

        for (const level of levels || []) {
          const price = String(level[0]);
          const quantity = Number(level[1] || 0);
          if (quantity <= 0) target.delete(price);
          else target.set(price, quantity);
        }
      };

      const snapshot = msg.type === 'snapshot';
      applyLevels(book.bids, msg.data.b, snapshot);
      applyLevels(book.asks, msg.data.a, snapshot);
      book.updatedAt = Date.now();

      this.orderBookCache.set(symbol, book);
      this.emit('market', symbol);
    }
  }

  getMarketSnapshot(symbol) {
    const ticker = this.tickerCache.get(symbol)?.data || {};
    const book = this.orderBookCache.get(symbol);

    const bids = book
      ? [...book.bids.entries()]
          .map(([price, quantity]) => [Number(price), Number(quantity)])
          .sort((a, b) => b[0] - a[0])
      : [];

    const asks = book
      ? [...book.asks.entries()]
          .map(([price, quantity]) => [Number(price), Number(quantity)])
          .sort((a, b) => a[0] - b[0])
      : [];

    return {
      symbol,
      lastPrice: Number(ticker.lastPrice || ticker.last || 0),
      volume24hUsd: Number(ticker.turnover24h || 0),
      fundingRate: Number(ticker.fundingRate || 0),
      fundingTime: ticker.nextFundingTime || null,
      bids,
      asks,
      tickerUpdatedAt: this.tickerCache.get(symbol)?.updatedAt || 0,
      orderBookUpdatedAt: book?.updatedAt || 0
    };
  }

  cleanupCache(maxAgeMs = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;

    for (const [symbol, entry] of this.tickerCache) {
      if (entry.updatedAt < cutoff) this.tickerCache.delete(symbol);
    }

    for (const [symbol, entry] of this.orderBookCache) {
      if (entry.updatedAt < cutoff) this.orderBookCache.delete(symbol);
    }
  }
}

module.exports = new BybitWS();
