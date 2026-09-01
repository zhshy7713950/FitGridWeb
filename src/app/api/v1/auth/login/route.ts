import { z } from "zod";

import { apiHandler, json, parseJsonBody } from "@/server/http/route-factory";
import { validateCredentials } from "@/server/auth/user-policy";
import { getAuth } from "@/server/auth/auth";
import { ApiError } from "@/server/http/api-error";
import { clientIp, loginAttempts } from "@/server/security/request-protection";
import { getRuntimeServices } from "@/server/runtime/services";

const schema = z.strictObject({ username: z.string(), password: z.string() });

export async function POST(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const parsed = schema.parse(await parseJsonBody(request));
    const attemptKey = `${clientIp(request.headers)}:${parsed.username.trim().toLowerCase()}`;
    loginAttempts.check(attemptKey);
    const credentials = validateCredentials(parsed.username, parsed.password);
    try {
      const services = getRuntimeServices();
      const result = await getAuth().api.signInUsername({
        body: credentials,
        headers: request.headers,
        returnHeaders: true,
      });
      const authUser = result.response.user as {
        id: string;
        username?: string | null;
        name: string;
        role?: string;
        status?: string;
        createdAt: Date;
      };
      const sessionToken = (result.response as { token?: string }).token;
      const databaseSession = sessionToken
        ? await services.prisma.session.findUnique({ where: { token: sessionToken } })
        : null;
      if (!databaseSession) throw new Error("DATABASE_SESSION_NOT_FOUND");
      loginAttempts.clear(attemptKey);
      return json(
        {
          user: {
            id: authUser.id,
            username: authUser.username ?? authUser.name,
            role: authUser.role === "admin" ? "admin" : "member",
            status: authUser.status === "disabled" ? "disabled" : "active",
            createdAt: new Date(authUser.createdAt).toISOString(),
          },
          expiresAt: databaseSession.expiresAt.toISOString(),
        },
        200,
        requestId,
        result.headers,
      );
    } catch {
      loginAttempts.recordFailure(attemptKey);
      throw new ApiError(401, "UNAUTHORIZED", "用户名或密码错误");
    }
  });
}
