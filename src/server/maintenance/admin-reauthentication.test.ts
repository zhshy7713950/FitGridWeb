import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";

import type { FitGridAuth } from "@/server/auth/auth";

import { reauthenticateAdmin } from "./admin-reauthentication";

function authWith(verifyPassword: ReturnType<typeof vi.fn>, signIn = vi.fn()): FitGridAuth {
  return { api: { verifyPassword, signInEmail: signIn } } as unknown as FitGridAuth;
}

describe("administrator reauthentication", () => {
  it("uses only the session-bound Better Auth verifier and does not create a session", async () => {
    const headers = new Headers({ cookie: "fitgridweb.session_token=current" });
    const verifyPassword = vi.fn().mockResolvedValue({ status: true });
    const signIn = vi.fn();

    await expect(reauthenticateAdmin(authWith(verifyPassword, signIn), headers, "current-password"))
      .resolves.toBeUndefined();

    expect(verifyPassword).toHaveBeenCalledWith({
      body: { password: "current-password" },
      headers,
    });
    expect(signIn).not.toHaveBeenCalled();
  });

  it("maps Better Auth password rejection to one public 401", async () => {
    const headers = new Headers();
    for (const authError of [
      new APIError("BAD_REQUEST"),
      new APIError("BAD_REQUEST", { code: "INVALID_PASSWORD", message: "hash mismatch" }),
    ]) {
      const verifyPassword = vi.fn().mockRejectedValue(authError);
      await expect(reauthenticateAdmin(authWith(verifyPassword), headers, "wrong-password"))
        .rejects.toMatchObject({ status: 401, code: "CURRENT_PASSWORD_INVALID" });
    }
  });

  it("classifies session and internal errors without leaking Better Auth details", async () => {
    const headers = new Headers();
    const sessionError = new APIError("UNAUTHORIZED", { message: "private cookie detail" });
    await expect(reauthenticateAdmin(authWith(vi.fn().mockRejectedValue(sessionError)), headers, "password"))
      .rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED", message: "未登录或会话已失效" });

    const internal = new APIError("INTERNAL_SERVER_ERROR", {
      code: "DATABASE_FAILURE",
      message: "postgresql://private-host/auth",
    });
    let caught: unknown;
    try {
      await reauthenticateAdmin(authWith(vi.fn().mockRejectedValue(internal)), headers, "password");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ status: 500, code: "REAUTHENTICATION_FAILED" });
    expect(JSON.stringify(caught)).not.toContain("private-host");
  });
});
