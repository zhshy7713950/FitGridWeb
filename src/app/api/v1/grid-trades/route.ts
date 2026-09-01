import { z } from "zod";

import { requireSession } from "@/server/auth/session";
import { apiHandler, json, parseJsonBody } from "@/server/http/route-factory";
import { getRuntimeServices } from "@/server/runtime/services";

const querySchema = z.strictObject({
  q: z.string().max(120).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function GET(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const user = await requireSession(request.headers, services.auth);
    const url = new URL(request.url);
    const query = querySchema.parse({
      q: url.searchParams.get("q") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    return json(await services.grid.list(user.id, query), 200, requestId);
  });
}

export async function POST(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const user = await requireSession(request.headers, services.auth);
    const created = await services.grid.create(user.id, await parseJsonBody(request));
    return json(created, 201, requestId);
  });
}
