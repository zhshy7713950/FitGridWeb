import { requireAdmin } from "@/server/auth/session";
import { apiHandler, json } from "@/server/http/route-factory";
import { getRuntimeServices } from "@/server/runtime/services";
import { z } from "zod";

const querySchema = z.strictObject({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function GET(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    await requireAdmin(request.headers, services.auth);
    const url = new URL(request.url);
    const query = querySchema.parse(Object.fromEntries(url.searchParams));
    return json(await services.admin.listUsers(query), 200, requestId);
  });
}
