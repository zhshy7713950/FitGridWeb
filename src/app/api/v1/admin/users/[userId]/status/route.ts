import { z } from "zod";

import { requireAdmin } from "@/server/auth/session";
import { apiHandler, json, parseJsonBody } from "@/server/http/route-factory";
import { getRuntimeServices } from "@/server/runtime/services";

const idSchema = z.string().uuid();
const bodySchema = z.strictObject({ status: z.enum(["active", "disabled"]) });

export async function PATCH(
  request: Request,
  context: { params: Promise<{ userId: string }> },
): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    await requireAdmin(request.headers, services.auth);
    const { userId } = await context.params;
    const body = bodySchema.parse(await parseJsonBody(request));
    const user = await services.admin.updateStatus(idSchema.parse(userId), body.status);
    return json(user, 200, requestId);
  });
}
