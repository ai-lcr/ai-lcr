import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { runIntegrity } from "@/lib/integrity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function persist() {
  const results = await runIntegrity();
  const pool = getPool();

  if (results.length > 0) {
    const placeholders = results
      .map((_, i) => `($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})`)
      .join(",");
    const params = results.flatMap((r) => [r.provider, r.model, r.check_name, r.status, r.detail]);
    await pool.query(
      `INSERT INTO provider_checks (provider, model, check_name, status, detail) VALUES ${placeholders}`,
      params,
    );
  }
  // Integrity runs daily — 30 days of history is plenty.
  await pool.query(`DELETE FROM provider_checks WHERE checked_at < now() - interval '30 days'`);

  return results;
}

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const results = await persist();
    return NextResponse.json({ checked_at: new Date().toISOString(), count: results.length, results });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
