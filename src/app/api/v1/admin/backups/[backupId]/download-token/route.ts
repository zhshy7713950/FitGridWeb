import { requireAdmin } from "@/server/auth/session";
import { json } from "@/server/http/route-factory";
import {
  assertMaintenanceAvailable,
  assertMaintenanceSameOrigin,
  backupNotFound,
  maintenanceApiHandler,
  requireBackupArtifact,
} from "@/server/maintenance/http";
import { portableBackupIdSchema } from "@/server/maintenance/types";
import { getRuntimeServices } from "@/server/runtime/services";
import { tokenIssueRequests } from "@/server/security/request-protection";

type RouteContext = { params: Promise<{ backupId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return maintenanceApiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const admin = await requireAdmin(request.headers, services.auth);
    assertMaintenanceSameOrigin(request);
    tokenIssueRequests.consume(admin.id);
    const parsed = portableBackupIdSchema.safeParse((await context.params).backupId);
    if (!parsed.success) throw backupNotFound();
    const backupId = parsed.data;
    assertMaintenanceAvailable(await services.maintenance.getMaintenanceMode());
    await requireBackupArtifact(() => services.maintenance.getBackupFile(backupId));
    const token = services.downloadTokens.issue({ adminId: admin.id, backupId });
    await services.downloadAudits.persist({
      event: "download-token-issued",
      actorId: admin.id,
      requestId,
      backupId,
    });
    return json({ token }, 201, requestId);
  });
}
