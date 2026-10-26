const WebSocket = require('ws');
const EventEmitter = require('events');
const config = require('../config');

class BybitWS extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.connected = false;
    this.url = config.BYBIT_WS_PUBLIC || 'wss://stream.bybit.com/v5/public/linear';
    this.subscribedSymbols = new Set();
  }

  isEnabled() {
    return !!config.USE_WS;
  }

  connect() {
    if (!this.isEnabled()) {
      console.log('WS disabled by config');
      return null;
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return this.socket;
    }

    this.socket = new WebSocket(this.url);

    this.socket.on('open', () => {
      this.connected = true;
      console.log('Bybit WS connected');
      this.emit('connected');

      if (this.subscribedSymbols.size) {
        this.subscribe([...this.subscribedSymbols]);
      }
    });

    this.socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg?.topic && String(msg.topic).startsWith('kline.')) {
          this.emit('kline', msg);
        }
      } catch (err) {
        console.error('WS parse error:', err.message);
      }
    });

    this.socket.on('close', () => {
      this.connected = false;
      console.log('Bybit WS closed');
      this.emit('disconnected');
    });

    this.socket.on('error', (err) => {
      console.error('Bybit WS error:', err.message);
    });

    return this.socket;
  }

  subscribe(symbols, timeframes = ['5', '15', '60', '240', 'D']) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const list = Array.from(new Set(symbols || [])).filter(Boolean);
    if (!list.length) return;

    for (const symbol of list) {
      this.subscribedSymbols.add(symbol);
    }

    const payload = {
      op: 'subscribe',
      args: list.flatMap((symbol) =>
        timeframes.map((tf) => `kline.${tf}.${symbol}`)
      )
    };

    this.socket.send(JSON.stringify(payload));
  }

  unsubscribe(symbols) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    const list = Array.from(new Set(symbols || [])).filter(Boolean);
    if (!list.length) return;

    for (const symbol of list) {
      this.subscribedSymbols.delete(symbol);
    }

    const payload = {
      op: 'unsubscribe',
      args: list.flatMap((symbol) =>
        ['5', '15', '60', '240', 'D'].map((tf) => `kline.${tf}.${symbol}`)
      )
    };

    this.socket.send(JSON.stringify(payload));
  }
}

module.exports = new BybitWS();
