import { apiHandler, json } from "@/server/http/route-factory";
import { getPrismaClient } from "@/server/db/client";
import { ApiError } from "@/server/http/api-error";

export async function GET(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    try {
      const rows = await getPrismaClient().$queryRaw<Array<{ ready: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM "_prisma_migrations"
          WHERE "migration_name" = '20260901000100_initial'
            AND "finished_at" IS NOT NULL
            AND "rolled_back_at" IS NULL
        ) AS "ready"
      `;
      if (!rows[0]?.ready) throw new Error("MIGRATION_NOT_READY");
    } catch {
      throw new ApiError(503, "SERVICE_NOT_READY", "服务尚未就绪");
    }
    return json({ status: "ok", database: "ok" }, 200, requestId);
  });
}
