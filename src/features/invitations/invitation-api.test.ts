import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientApiError } from "@/lib/api-client";
import { acceptInvitation, getInvitationStatus } from "./invitation-api";

afterEach(() => {
  vi.doUnmock("./demo-invitation-data");
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("invitation API", () => {
  it("URL-encodes a public invitation token exactly once", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      status: "valid",
      expiresAt: "2026-09-03T00:00:00.000Z",
    }));
    vi.stubGlobal("fetch", fetcher);

    await getInvitationStatus("token/part%2Fencoded");

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/invitations/token%2Fpart%252Fencoded",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("posts only the username and password to the encoded acceptance endpoint", async () => {
    const user = {
      id: "user-1",
      username: "new-member",
      role: "member",
      status: "active",
      createdAt: "2026-09-02T00:00:00.000Z",
    };
    const fetcher = vi.fn().mockResolvedValue(Response.json(user, { status: 201 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(acceptInvitation("token/value", "new-member", "strong-password-1"))
      .resolves.toMatchObject({ username: "new-member" });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/invitations/token%2Fvalue/accept",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ username: "new-member", password: "strong-password-1" }),
      }),
    );
  });

  it("forwards an AbortSignal to the acceptance request", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      id: "user-1",
      username: "member",
      role: "member",
      status: "active",
    }, { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const requestWithSignal = acceptInvitation as (
      token: string,
      username: string,
      password: string,
      signal?: AbortSignal,
    ) => ReturnType<typeof acceptInvitation>;

    await requestWithSignal("token-value", "member", "strong-password-1", controller.signal);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/invitations/token-value/accept",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("preserves the public error envelope, request ID, and retry delay", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { code: "RATE_LIMITED", message: "请求过快", requestId: "01INVITE" },
      { status: 429, headers: { "Retry-After": "41" } },
    )));

    await expect(getInvitationStatus("valid-token-value-0000000000000001")).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      message: "请求过快",
      requestId: "01INVITE",
      retryAfterSeconds: 41,
    });
  });

  it("uses only the deterministic invitation in local UI demo mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(getInvitationStatus("valid-demo-invitation-token-000001")).resolves.toEqual({
      status: "valid",
      expiresAt: "2099-12-31T23:59:59.000Z",
    });
    await expect(getInvitationStatus("another-demo-invitation-token-00001")).rejects.toEqual(
      expect.objectContaining({ status: 404, code: "INVITATION_NOT_FOUND" }),
    );
    await expect(
      acceptInvitation("valid-demo-invitation-token-000001", "member", "strong-password-1"),
    ).resolves.toMatchObject({ username: "member", role: "member", status: "active" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never initializes demo invitation data when the production module loads", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "0");
    const initializeDemoData = vi.fn();
    vi.doMock("./demo-invitation-data", () => {
      initializeDemoData();
      return {};
    });

    await import("./invitation-api");

    expect(initializeDemoData).not.toHaveBeenCalled();
  });

  it("does not treat a production demo flag as authorization to bypass the API", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
    const fetcher = vi.fn().mockResolvedValue(Response.json(
      { code: "INVITATION_NOT_FOUND", message: "邀请不存在", requestId: "01REAL" },
      { status: 404 },
    ));
    vi.stubGlobal("fetch", fetcher);

    const error = await getInvitationStatus("valid-demo-invitation-token-000001")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClientApiError);
    expect(error).toMatchObject({ status: 404, requestId: "01REAL" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
