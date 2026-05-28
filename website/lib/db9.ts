import { Pool } from "pg";

// db9 (https://db9.ai) is plain Postgres over TLS. Reuse one pool across
// hot-reloads / serverless invocations instead of opening a socket per request.
declare global {
  // eslint-disable-next-line no-var
  var __db9Pool: Pool | undefined;
}

export function getPool(): Pool {
  const connectionString = process.env.DB9_DATABASE_URL;
  if (!connectionString) {
    throw new Error("DB9_DATABASE_URL is not set");
  }
  if (!globalThis.__db9Pool) {
    globalThis.__db9Pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10_000,
    });
  }
  return globalThis.__db9Pool;
}
