import { APIError } from "better-auth/api";

import type { FitGridAuth } from "@/server/auth/auth";
import { ApiError } from "@/server/http/api-error";

export async function reauthenticateAdmin(
  auth: FitGridAuth,
  headers: Headers,
  password: string,
): Promise<void> {
  try {
    await auth.api.verifyPassword({ body: { password }, headers });
  } catch (error) {
    if (!(error instanceof APIError)) throw error;
    if (error.statusCode === 401) {
      throw new ApiError(401, "UNAUTHORIZED", "未登录或会话已失效");
    }
    if (error.statusCode >= 400 && error.statusCode < 500) {
      throw new ApiError(401, "CURRENT_PASSWORD_INVALID", "当前密码错误");
    }
    throw new ApiError(500, "REAUTHENTICATION_FAILED", "当前密码验证暂时无法完成");
  }
}
