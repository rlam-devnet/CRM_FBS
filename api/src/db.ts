import { Pool, PoolClient, QueryResultRow } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'fbs_admin',
  password: process.env.PGPASSWORD || 'fbs_secret_password_2026',
  database: process.env.PGDATABASE || 'fbs_crm',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export function getClient(): Promise<PoolClient> {
  return pool.connect();
}
