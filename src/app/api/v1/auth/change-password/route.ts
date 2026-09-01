import { z } from "zod";

import { getAuth } from "@/server/auth/auth";
import { requireSession } from "@/server/auth/session";
import { apiHandler, noContent, parseJsonBody } from "@/server/http/route-factory";

const schema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
});

export async function POST(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const auth = getAuth();
    await requireSession(request.headers, auth);
    const body = schema.parse(await parseJsonBody(request));
    const result = await auth.api.changePassword({
      body: { ...body, revokeOtherSessions: true },
      headers: request.headers,
      returnHeaders: true,
    });
    return noContent(requestId, result.headers);
  });
}
