require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const debugRoutes = require('./routes/debug');
const { bootstrapStrategy } = require('./services/strategyEngine');
const { pool } = require('./db');

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
  // Search common paths for the migration file dynamically
  const possibleFolders = [
    path.join(__dirname, '../migration'),
    path.join(__dirname, './migration'),
    path.join(process.cwd(), 'migration')
  ];

  let migrationFile = null;

  for (const folder of possibleFolders) {
    if (fs.existsSync(folder)) {
      const files = fs.readdirSync(folder);
      const found = files.find(f => f.endsWith('.sql') || f.endsWith('.db') || f.includes('init'));
      if (found) {
        migrationFile = path.join(folder, found);
        break;
      }
    }
  }

  if (migrationFile && fs.existsSync(migrationFile)) {
    console.log(`Running database migration from: ${migrationFile}`);
    const sql = fs.readFileSync(migrationFile, 'utf8');
    await pool.query(sql);
    console.log('Database migrations completed successfully.');
  } else {
    console.warn('WARNING: No migration file found. Skipping automated schema creation.');
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
