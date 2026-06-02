import { Pool } from "pg";

// Plain Postgres over TLS (Supabase). Reuse one pool across hot-reloads /
// serverless invocations instead of opening a socket per request.
declare global {
  // eslint-disable-next-line no-var
  var __statusPool: Pool | undefined;
}

export function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  if (!globalThis.__statusPool) {
    globalThis.__statusPool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10_000,
    });
  }
  return globalThis.__statusPool;
}
