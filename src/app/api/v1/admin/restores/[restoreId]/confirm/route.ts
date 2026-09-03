import { z } from "zod";

import { requireAdmin } from "@/server/auth/session";
import { json, parseJsonBody } from "@/server/http/route-factory";
import { reauthenticateAdmin } from "@/server/maintenance/admin-reauthentication";
import {
  assertMaintenanceAvailable,
  maintenanceApiHandler,
  maintenanceNotFound,
} from "@/server/maintenance/http";
import { maintenanceUuidSchema } from "@/server/maintenance/types";
import { getRuntimeServices } from "@/server/runtime/services";
import { restoreConfirmationRequests } from "@/server/security/request-protection";

const bodySchema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  confirmationPhrase: z.literal("恢复全部数据"),
});

type RouteContext = { params: Promise<{ restoreId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return maintenanceApiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const admin = await requireAdmin(request.headers, services.auth);
    restoreConfirmationRequests.consume(admin.id);
    const body = bodySchema.parse(await parseJsonBody(request));
    const parsed = maintenanceUuidSchema.safeParse((await context.params).restoreId);
    if (!parsed.success) throw maintenanceNotFound();
    const restoreId = parsed.data;
    assertMaintenanceAvailable(await services.maintenance.getMaintenanceMode());

    const challenge = await services.maintenance.getJob(restoreId);
    if (
      challenge.id !== restoreId
      || challenge.type !== "inspect-restore"
      || challenge.state !== "awaiting-confirmation"
      || challenge.expiresAt === undefined
      || challenge.expiresAt <= Math.floor(Date.now() / 1_000)
    ) throw maintenanceNotFound();

    await reauthenticateAdmin(services.auth, request.headers, body.currentPassword);
    return json(await services.maintenance.confirmRestore({
      actorId: admin.id,
      requestId,
      restoreId,
    }), 202, requestId);
  });
}
