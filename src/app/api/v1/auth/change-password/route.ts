import { z } from "zod";

import { getAuth } from "@/server/auth/auth";
import { requireSession } from "@/server/auth/session";
import { apiHandler, noContent, parseJsonBody } from "@/server/http/route-factory";
import { ApiError } from "@/server/http/api-error";
import { ownerMutationRequests } from "@/server/security/request-protection";
import { APIError } from "better-auth/api";

const schema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
});

function publicPasswordError(error: APIError): ApiError {
  const code = error.body?.code;

  if (code === "INVALID_PASSWORD") {
    return new ApiError(401, "CURRENT_PASSWORD_INVALID", "当前密码错误");
  }
  if (error.statusCode === 401) {
    return new ApiError(401, "UNAUTHORIZED", "未登录或会话已失效");
  }
  if (code === "CREDENTIAL_ACCOUNT_NOT_FOUND") {
    return new ApiError(400, "PASSWORD_CHANGE_UNAVAILABLE", "当前账号不支持修改密码");
  }
  if (code === "FAILED_TO_GET_SESSION") {
    return new ApiError(
      500,
      "SESSION_REPLACEMENT_FAILED",
      "密码可能已更新，但会话刷新失败，请重新登录",
    );
  }
  if (error.statusCode >= 400 && error.statusCode < 500) {
    return new ApiError(error.statusCode, "PASSWORD_CHANGE_REJECTED", "密码修改请求无法完成");
  }
  return new ApiError(500, "PASSWORD_CHANGE_FAILED", "密码修改暂时无法完成");
}

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
    } catch (error) {
      if (!(error instanceof APIError)) throw error;
      throw publicPasswordError(error);
    }
  });
}
