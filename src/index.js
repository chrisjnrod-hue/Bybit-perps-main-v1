require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const debugRoutes = require('./routes/debug');
const { bootstrapStrategy } = require('./services/strategyEngine');
const { pool } = require('./db'); //

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

async function runMigrations() {
  // Update path/filename to match your actual migration file name
  const migrationPath = path.join(__dirname, '../migration/001_init.sql'); 
  
  if (fs.existsSync(migrationPath)) {
    console.log('Running database migrations...');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await pool.query(sql);
    console.log('Database migrations completed successfully.');
  } else {
    console.warn(`Migration file not found at: ${migrationPath}`);
  }
}

async function start() {
  await runMigrations();
  await bootstrapStrategy();
  app.listen(port, () => {
    console.log(`Bot listening on port ${port}`);
  });
}

start().catch((err) => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});
