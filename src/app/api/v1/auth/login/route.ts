import { z } from "zod";

import { apiHandler, json, parseJsonBody } from "@/server/http/route-factory";
import { validateCredentials } from "@/server/auth/user-policy";
import { getAuth } from "@/server/auth/auth";
import { ApiError } from "@/server/http/api-error";

const schema = z.strictObject({ username: z.string(), password: z.string() });

export async function POST(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const parsed = schema.parse(await parseJsonBody(request));
    const credentials = validateCredentials(parsed.username, parsed.password);
    try {
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
      return json(
        {
          user: {
            id: authUser.id,
            username: authUser.username ?? authUser.name,
            role: authUser.role === "admin" ? "admin" : "member",
            status: authUser.status === "disabled" ? "disabled" : "active",
            createdAt: new Date(authUser.createdAt).toISOString(),
          },
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        },
        200,
        requestId,
        result.headers,
      );
    } catch {
      throw new ApiError(401, "UNAUTHORIZED", "用户名或密码错误");
    }
  });
}
