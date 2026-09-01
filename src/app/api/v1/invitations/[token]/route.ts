import { z } from "zod";

import { apiHandler, json } from "@/server/http/route-factory";
import { getRuntimeServices } from "@/server/runtime/services";

const tokenSchema = z.string().min(32).max(512);

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const { token } = await context.params;
    const status = await getRuntimeServices().invitations.status(tokenSchema.parse(token));
    return json(status, 200, requestId);
  });
}
