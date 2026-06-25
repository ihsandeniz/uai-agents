import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@uai/db/schema';
import { logger } from './logger.js';

const connectionString = process.env.DATABASE_URL || 'postgres://uai:uai_dev_2026@localhost:5434/uai';

const sql = postgres(connectionString, {
  max: 10,
  onnotice: () => {},
});

export const db = drizzle(sql, { schema });

export async function pingDb(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch (err) {
    logger.error({ err }, 'DB ping failed');
    return false;
  }
}

export { sql };
