import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientApiError } from "@/lib/api-client";
import { changePassword } from "./account-api";

afterEach(() => {
  vi.doUnmock("./demo-account-data");
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("account API", () => {
  it("posts exactly the two password fields to the same-origin change endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(changePassword("current-secret", "replacement-secret"))
      .resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/auth/change-password",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          currentPassword: "current-secret",
          newPassword: "replacement-secret",
        }),
      }),
    );
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(Object.keys(JSON.parse(String(init.body)))).toEqual([
      "currentPassword",
      "newPassword",
    ]);
  });

  it("forwards the caller AbortSignal", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();

    await changePassword("current-secret", "replacement-secret", controller.signal);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/auth/change-password",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("preserves a public password error without treating it as session expiry", async () => {
    const locationReplace = vi.fn();
    vi.stubGlobal("window", { location: { replace: locationReplace } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      {
        code: "CURRENT_PASSWORD_INVALID",
        message: "当前密码错误",
        requestId: "01PASSWORD",
      },
      { status: 401 },
    )));

    await expect(changePassword("wrong-current", "replacement-secret")).rejects.toMatchObject({
      status: 401,
      code: "CURRENT_PASSWORD_INVALID",
      message: "当前密码错误",
      requestId: "01PASSWORD",
    });
    expect(locationReplace).not.toHaveBeenCalled();
  });

  it("preserves field errors and Retry-After from the API envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      {
        code: "VALIDATION_FAILED",
        message: "请求字段校验失败",
        requestId: "01VALIDATION",
        fieldErrors: { newPassword: ["密码长度必须为 12–128 个字符"] },
      },
      { status: 429, headers: { "Retry-After": "9" } },
    )));

    await expect(changePassword("current-secret", "short-password")).rejects.toMatchObject({
      status: 429,
      code: "VALIDATION_FAILED",
      requestId: "01VALIDATION",
      fieldErrors: { newPassword: ["密码长度必须为 12–128 个字符"] },
      retryAfterSeconds: 9,
    });
  });

  it("uses a deterministic success adapter only in local UI demo mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(changePassword("fitgrid-demo", "replacement-secret"))
      .resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never initializes demo account data when the production module loads", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "0");
    const initializeDemoData = vi.fn();
    vi.doMock("./demo-account-data", () => {
      initializeDemoData();
      return {};
    });

    await import("./account-api");

    expect(initializeDemoData).not.toHaveBeenCalled();
  });

  it("does not let a production demo flag bypass the real API", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { code: "CURRENT_PASSWORD_INVALID", message: "当前密码错误", requestId: "01REAL" },
      { status: 401 },
    )));

    const error = await changePassword("fitgrid-demo", "replacement-secret")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClientApiError);
    expect(error).toMatchObject({ requestId: "01REAL" });
  });
});
