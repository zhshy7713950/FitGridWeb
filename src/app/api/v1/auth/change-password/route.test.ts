import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";

const { consume, getAuth } = vi.hoisted(() => ({
  consume: vi.fn(),
  getAuth: vi.fn(),
}));

vi.mock("@/server/auth/auth", () => ({ getAuth }));
vi.mock("@/server/security/request-protection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/security/request-protection")>();
  return {
    ...actual,
    ownerMutationRequests: { consume },
  };
});

import { POST } from "./route";

afterEach(() => {
  consume.mockReset();
  getAuth.mockReset();
});

describe("POST /api/v1/auth/change-password", () => {
  it.each([
    [
      new APIError("BAD_REQUEST", {
        code: "INVALID_PASSWORD",
        message: "Invalid password",
      }),
      401,
      "CURRENT_PASSWORD_INVALID",
      "当前密码错误",
    ],
    [
      new APIError("BAD_REQUEST", {
        code: "CREDENTIAL_ACCOUNT_NOT_FOUND",
        message: "Credential account not found",
      }),
      400,
      "PASSWORD_CHANGE_UNAVAILABLE",
      "当前账号不支持修改密码",
    ],
    [
      new APIError("INTERNAL_SERVER_ERROR", {
        code: "FAILED_TO_GET_SESSION",
        message: "Failed to get session after password update",
      }),
      500,
      "SESSION_REPLACEMENT_FAILED",
      "密码可能已更新，但会话刷新失败，请重新登录",
    ],
    [
      new APIError("INTERNAL_SERVER_ERROR", {
        code: "DATABASE_FAILURE",
        message: "postgresql://private-host/session-table",
      }),
      500,
      "PASSWORD_CHANGE_FAILED",
      "密码修改暂时无法完成",
    ],
  ])("classifies Better Auth failures without leaking internals", async (
    authError,
    expectedStatus,
    expectedCode,
    expectedMessage,
  ) => {
    getAuth.mockReturnValue(authFor({ changePasswordError: authError }));

    const response = await POST(passwordRequest());
    const body = await response.json();

    expect(response.status).toBe(expectedStatus);
    expect(body).toMatchObject({ code: expectedCode, message: expectedMessage });
    expect(JSON.stringify(body)).not.toContain(authError.body?.message);
  });

  it("preserves ordinary invalid-session semantics before calling changePassword", async () => {
    const changePassword = vi.fn();
    getAuth.mockReturnValue(authFor({ session: null, changePassword }));

    const response = await POST(passwordRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "UNAUTHORIZED",
      message: "未登录或会话已失效",
    });
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("keeps Better Auth's replacement session cookie on a successful no-content response", async () => {
    const headers = new Headers({
      "Set-Cookie": "better-auth.session_token=replacement; Path=/; HttpOnly; SameSite=Lax",
    });
    const changePassword = vi.fn().mockResolvedValue({
      headers,
      response: { token: "replacement" },
    });
    getAuth.mockReturnValue(authFor({ changePassword }));

    const response = await POST(passwordRequest());

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=replacement");
    expect(changePassword).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        currentPassword: "current-password",
        newPassword: "replacement-password",
        revokeOtherSessions: true,
      },
      returnHeaders: true,
    }));
  });
});

function passwordRequest(): Request {
  return new Request("https://fitgrid.example/api/v1/auth/change-password", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "fitgrid.example",
      Origin: "https://fitgrid.example",
    },
    body: JSON.stringify({
      currentPassword: "current-password",
      newPassword: "replacement-password",
    }),
  });
}

function authFor({
  session = {
    user: {
      id: "user-password-test",
      name: "password.user",
      username: "password.user",
      role: "member",
      status: "active",
    },
  },
  changePassword = vi.fn(),
  changePasswordError,
}: {
  session?: unknown;
  changePassword?: ReturnType<typeof vi.fn>;
  changePasswordError?: APIError;
} = {}) {
  if (changePasswordError) changePassword.mockRejectedValue(changePasswordError);
  return {
    api: {
      getSession: vi.fn().mockResolvedValue(session),
      changePassword,
    },
  } as never;
}
