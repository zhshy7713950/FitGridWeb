import { z } from "zod";

import { requireAdmin } from "@/server/auth/session";
import { apiHandler, json, parseJsonBody } from "@/server/http/route-factory";
import { getRuntimeServices } from "@/server/runtime/services";
import { ownerMutationRequests } from "@/server/security/request-protection";

const idSchema = z.string().uuid();
const bodySchema = z.strictObject({ status: z.enum(["active", "disabled"]) });

export async function PATCH(
  request: Request,
  context: { params: Promise<{ userId: string }> },
): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const admin = await requireAdmin(request.headers, services.auth);
    ownerMutationRequests.consume(admin.id);
    const { userId } = await context.params;
    const body = bodySchema.parse(await parseJsonBody(request));
    const user = await services.admin.updateStatus(idSchema.parse(userId), body.status);
    return json(user, 200, requestId);
  });
}
