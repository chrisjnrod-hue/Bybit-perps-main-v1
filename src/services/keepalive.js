const axios = require('axios');
const config = require('../config');

function setupKeepAlive() {
  if (!config.ENABLE_KEEPALIVE_PING || !config.KEEPALIVE_URL) return null;

  const interval = setInterval(async () => {
    try {
      await axios.get(config.KEEPALIVE_URL, { timeout: 7000 });
      console.log('Keep-alive ping sent successfully.');
    } catch (err) {
      console.error('Keep-alive ping failed:', err.message);
    }
  }, config.KEEPALIVE_INTERVAL_MS || 300000);

  return interval;
}

module.exports = {
  setupKeepAlive
};
