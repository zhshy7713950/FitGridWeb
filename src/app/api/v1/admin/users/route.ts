import { requireAdmin } from "@/server/auth/session";
import { apiHandler, json } from "@/server/http/route-factory";
import { getRuntimeServices } from "@/server/runtime/services";

export async function GET(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    await requireAdmin(request.headers, services.auth);
    return json(await services.admin.listUsers(), 200, requestId);
  });
}
