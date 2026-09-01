import { z } from "zod";

import { requireSession } from "@/server/auth/session";
import { apiHandler, json } from "@/server/http/route-factory";
import { getRuntimeServices } from "@/server/runtime/services";
import { ownerMutationRequests } from "@/server/security/request-protection";

const idSchema = z.string().uuid();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const user = await requireSession(request.headers, services.auth);
    ownerMutationRequests.consume(user.id);
    const { id } = await context.params;
    return json(await services.grid.recalculate(user.id, idSchema.parse(id)), 200, requestId);
  });
}
