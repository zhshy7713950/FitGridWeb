import { z } from "zod";

import { getAuth } from "@/server/auth/auth";
import { requireSession } from "@/server/auth/session";
import { apiHandler, noContent, parseJsonBody } from "@/server/http/route-factory";
import { ApiError } from "@/server/http/api-error";
import { ownerMutationRequests } from "@/server/security/request-protection";

const schema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
});

export async function POST(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const auth = getAuth();
    const user = await requireSession(request.headers, auth);
    ownerMutationRequests.consume(user.id);
    const body = schema.parse(await parseJsonBody(request));
    try {
      const result = await auth.api.changePassword({
        body: { ...body, revokeOtherSessions: true },
        headers: request.headers,
        returnHeaders: true,
      });
      return noContent(requestId, result.headers);
    } catch {
      throw new ApiError(401, "CURRENT_PASSWORD_INVALID", "当前密码错误");
    }
  });
}
