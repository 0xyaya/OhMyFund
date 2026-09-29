import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

export const db = new pg.Pool({ connectionString: databaseUrl, max: 8, idleTimeoutMillis: 30000 });
