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

// Root endpoint for Render health checks
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

// Health endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    useWs: Boolean(config.USE_WS),
    port: Number(process.env.PORT || 3000)
  });
});

app.use('/debug', debugRoutes);

const port = Number(process.env.PORT || 3000);

async function runMigrations() {
  const possibleFolders = [
    path.join(__dirname, '../migrations'),
    path.join(__dirname, '../migration'),
    path.join(__dirname, './migrations'),
    path.join(__dirname, './migration'),
    path.join(process.cwd(), 'migrations'),
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

  app.listen(port, '0.0.0.0', () => {
    console.log(`Bot listening on port ${port}`);
  });

  bootstrapStrategy().catch((err) => {
    console.error('Strategy bootstrap failed:', err.message);
  });
}

start().catch((err) => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});
