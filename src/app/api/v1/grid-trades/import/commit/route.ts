import { z } from "zod";

import { requireSession } from "@/server/auth/session";
import { apiHandler, json, parseJsonBody } from "@/server/http/route-factory";
import { getRuntimeServices } from "@/server/runtime/services";
import { ownerMutationRequests } from "@/server/security/request-protection";

const schema = z.strictObject({
  previewToken: z.string().min(32).max(512),
  conflictPolicy: z.enum(["skip", "overwrite"]),
});

export async function POST(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const user = await requireSession(request.headers, services.auth);
    ownerMutationRequests.consume(user.id);
    const body = schema.parse(await parseJsonBody(request));
    return json(
      await services.imports.commit(user.id, body.previewToken, body.conflictPolicy),
      200,
      requestId,
    );
  });
}
