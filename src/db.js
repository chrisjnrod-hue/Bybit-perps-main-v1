const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.DB_SSL ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function testConnection() {
  try {
    const result = await pool.query('SELECT NOW()');
    console.log('PostgreSQL connected:', result.rows[0].now);
  } catch (err) {
    console.error('PostgreSQL connection failed:', err.message);
  }
}

module.exports = {
  query,
  pool,
  testConnection
};
