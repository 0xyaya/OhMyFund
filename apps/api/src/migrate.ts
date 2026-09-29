import { readFile } from 'node:fs/promises';
import { db } from './db.js';

const client = await db.connect();
try {
  await client.query('BEGIN');
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const migration of ['001_initial.sql', '002_fund_activity.sql', '003_public_funds.sql', '004_recurring_execution.sql', '005_sponsored_execution.sql', '006_recurring_account_setup.sql', '007_sponsor_policy_lifecycle.sql']) {
    const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [migration]);
    if (applied.rowCount) continue;
    const sql = await readFile(new URL(`../sql/${migration}`, import.meta.url), 'utf8');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration]);
  }
  await client.query('COMMIT');
  console.log('Migrations 001–007 applied');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await db.end();
}
