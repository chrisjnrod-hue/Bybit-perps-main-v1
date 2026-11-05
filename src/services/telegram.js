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
    console.warn('[telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID; skipping send.');
    return null;
  }

  if (dedupeKey) {
    const now = Date.now();
    const lastAt = telegramDedupe.get(dedupeKey);

    if (lastAt && now - lastAt < ttlMs) {
      return null;
    }
  }

  const safeText = String(text ?? '').slice(0, 4096);

  try {
    const res = await axios.post(
      buildRequestUrl(),
      {
        chat_id: config.TELEGRAM_CHAT_ID,
        text: safeText
      },
      {
        timeout: 10000
      }
    );

    if (dedupeKey) {
      telegramDedupe.set(dedupeKey, Date.now());
    }

    return res;
  } catch (err) {
    console.error('[telegram] send failed:', {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data
    });
    return null;
  }
}

module.exports = {
  sendTelegramMessage,
  telegramDedupe
};
