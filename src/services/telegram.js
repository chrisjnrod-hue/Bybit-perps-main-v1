const axios = require('axios');
const config = require('../config');

const telegramDedupe = new Map();

function buildRequestUrl() {
  return `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
}

async function sendTelegramMessage(text, options = {}) {
  const {
    dedupeKey = null,
    ttlMs = config.TELEGRAM_DEDUPE_TTL_MS || 60 * 1000
  } = options;

  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    return null;
  }

  if (dedupeKey) {
    const now = Date.now();
    const lastAt = telegramDedupe.get(dedupeKey);
    if (lastAt && now - lastAt < ttlMs) {
      return null;
    }
    telegramDedupe.set(dedupeKey, now);
  }

  return axios.post(
    buildRequestUrl(),
    {
      chat_id: config.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown'
    }
  );
}

module.exports = {
  sendTelegramMessage,
  telegramDedupe
};
