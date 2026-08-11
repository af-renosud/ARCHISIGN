import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Connections are established lazily on first query (never at boot).
// connectionTimeoutMillis keeps a slow/unreachable database from hanging a
// request indefinitely instead of failing fast.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
});
export const db = drizzle(pool, { schema });
