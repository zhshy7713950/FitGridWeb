import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientApiError, requestJson } from "./api-client";

afterEach(() => vi.unstubAllGlobals());

describe("requestJson", () => {
  it("returns JSON from a same-origin API request", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status: "ok" }));
    vi.stubGlobal("fetch", fetcher);

    await expect(requestJson<{ status: string }>("/health")).resolves.toEqual({ status: "ok" });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/health", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("normalizes the public error envelope and Retry-After", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { code: "RATE_LIMITED", message: "请求过快", requestId: "01REQ" },
      { status: 429, headers: { "Retry-After": "37" } },
    )));

    await expect(requestJson("/auth/login")).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      requestId: "01REQ",
      retryAfterSeconds: 37,
    });
  });

  it("uses the public fallback error for a non-JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream proxy error", { status: 502 })));

    const error = await requestJson("/health").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ClientApiError);
    expect(error).toMatchObject({
      status: 502,
      code: "REQUEST_FAILED",
      message: "请求失败",
    });
    expect((error as Error).message).not.toContain("upstream proxy error");
  });

  it("uses the public fallback error for a null JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(null, { status: 502 })));

    await expect(requestJson("/health")).rejects.toMatchObject({
      status: 502,
      code: "REQUEST_FAILED",
      message: "请求失败",
    });
  });

  it("accepts an empty 204 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(requestJson<void>("/auth/logout", { method: "POST" })).resolves.toBeUndefined();
  });

  it("invokes the session-expiry boundary for non-login 401 responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { code: "UNAUTHORIZED", message: "未登录或会话已失效" },
      { status: 401 },
    )));
    const onUnauthorized = vi.fn();

    await expect(requestJson("/grid-trades", {}, onUnauthorized)).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
