import { createHash } from "node:crypto";

import { ApiError } from "@/server/http/api-error";

const USERNAME_PATTERN = /^[a-z0-9._]+$/;

export function validateCredentials(usernameValue: unknown, passwordValue: unknown) {
  const username = typeof usernameValue === "string" ? usernameValue.trim().toLowerCase() : "";
  if (username.length < 3 || username.length > 64 || !USERNAME_PATTERN.test(username)) {
    throw new ApiError(
      422,
      "USERNAME_INVALID",
      "用户名必须为 3–64 个小写字母、数字、点或下划线",
      { username: ["用户名格式无效"] },
    );
  }
  if (typeof passwordValue !== "string" || passwordValue.length < 12 || passwordValue.length > 128) {
    throw new ApiError(422, "PASSWORD_INVALID", "密码长度必须为 12–128 个字符", {
      password: ["密码长度必须为 12–128 个字符"],
    });
  }
  return { username, password: passwordValue };
}

export function internalEmailForUsername(username: string): string {
  return `${createHash("sha256").update(username).digest("hex")}@users.fitgridweb.invalid`;
}
