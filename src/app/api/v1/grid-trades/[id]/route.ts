import { z } from "zod";

import { requireSession } from "@/server/auth/session";
import { apiHandler, json, noContent, parseJsonBody } from "@/server/http/route-factory";
import { getRuntimeServices } from "@/server/runtime/services";

const idSchema = z.string().uuid();
type RouteContext = { params: Promise<{ id: string }> };

async function ownerAndId(request: Request, context: RouteContext) {
  const services = getRuntimeServices();
  const user = await requireSession(request.headers, services.auth);
  const { id } = await context.params;
  return { services, ownerId: user.id, id: idSchema.parse(id) };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const { services, ownerId, id } = await ownerAndId(request, context);
    return json(await services.grid.get(ownerId, id), 200, requestId);
  });
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const { services, ownerId, id } = await ownerAndId(request, context);
    const updated = await services.grid.update(ownerId, id, await parseJsonBody(request));
    return json(updated, 200, requestId);
  });
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const { services, ownerId, id } = await ownerAndId(request, context);
    await services.grid.delete(ownerId, id);
    return noContent(requestId);
  });
}
