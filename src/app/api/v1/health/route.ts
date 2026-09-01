import { apiHandler, json } from "@/server/http/route-factory";
import { getPrismaClient } from "@/server/db/client";
import { ApiError } from "@/server/http/api-error";

export async function GET(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    try {
      await getPrismaClient().$queryRaw`SELECT 1`;
    } catch {
      throw new ApiError(503, "SERVICE_NOT_READY", "服务尚未就绪");
    }
    return json({ status: "ok", database: "ok" }, 200, requestId);
  });
}
