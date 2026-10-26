const axios = require('axios');
const config = require('../config');

async function sendTelegramMessage(text) {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    return null;
  }

  return axios.post(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      chat_id: config.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown'
    }
  );
}

module.exports = {
  sendTelegramMessage
};