import { requireAdmin } from "@/server/auth/session";
import { json } from "@/server/http/route-factory";
import {
  assertMaintenanceSameOrigin,
  maintenanceApiHandler,
  maintenanceNotFound,
} from "@/server/maintenance/http";
import { maintenanceUuidSchema } from "@/server/maintenance/types";
import { getRuntimeServices } from "@/server/runtime/services";
import { maintenanceStatusRequests } from "@/server/security/request-protection";

type RouteContext = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return maintenanceApiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const admin = await requireAdmin(request.headers, services.auth);
    assertMaintenanceSameOrigin(request);
    maintenanceStatusRequests.consume(admin.id);
    const parsed = maintenanceUuidSchema.safeParse((await context.params).jobId);
    if (!parsed.success) throw maintenanceNotFound();
    return json(await services.maintenance.getJob(parsed.data), 200, requestId);
  });
}
