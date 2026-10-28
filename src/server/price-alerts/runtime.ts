import { timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { ApiError } from "@/server/http/api-error";

export function authorizeTask(request: Request, secret: string) {
  if (secret.length < 32) throw new ApiError(503, "TASK_NOT_CONFIGURED", "预警后台任务尚未配置");
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApiError(401, "TASK_UNAUTHORIZED", "拒绝访问后台任务");
}
let taskPool: Pool | undefined;
let running = false;
export async function withTaskLock<T>(operation: () => Promise<T>): Promise<T | { skipped: "busy" }> {
  if (!process.env.DATABASE_URL) throw new ApiError(503, "TASK_NOT_CONFIGURED", "数据库尚未配置");
  if (running) return { skipped: "busy" };
  running = true;
  try {
    taskPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 60000, statement_timeout: 5000, allowExitOnIdle: true, application_name: "fitgrid-price-alerts-lock" });
    const client = await taskPool.connect(); let acquired = false;
    try {
      acquired = (await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(1950149, 1) AS locked")).rows[0].locked;
      if (!acquired) return { skipped: "busy" };
      return await operation();
    } finally {
      try { if (acquired) await client.query("SELECT pg_advisory_unlock(1950149, 1)"); }
      finally { client.release(); }
    }
  } finally { running = false; }
}
