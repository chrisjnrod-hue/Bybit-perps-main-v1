require('dotenv').config();
const express = require('express');
const config = require('./config');
const debugRoutes = require('./routes/debug');
const { bootstrapStrategy } = require('./services/strategyEngine');

const app = express();
app.use(express.json());
app.use('/debug', debugRoutes);

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    useWs: config.USE_WS,
    port: Number(config.PORT || 3000)
  });
});

const port = Number(config.PORT || 3000);

async function start() {
  await bootstrapStrategy();
  app.listen(port, () => {
    console.log(`Bot listening on port ${port}`);
  });
}

start().catch((err) => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});
