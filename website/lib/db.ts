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
    const pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10_000,
    });
    // The status tables live in the `lcr` schema of the shared (freeart)
    // Supabase project, not `public`. Pin it on every connection so bare table
    // names resolve. Supabase's pooler ignores the `options=search_path` startup
    // param, so we SET it per connection instead. Swallow errors: in prod a
    // dedicated role already defaults search_path to lcr, making this redundant.
    pool.on("connect", (c) => {
      c.query("SET search_path TO lcr, public").catch(() => {});
    });
    globalThis.__statusPool = pool;
  }
  return globalThis.__statusPool;
}
