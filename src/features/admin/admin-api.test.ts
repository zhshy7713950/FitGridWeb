import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientApiError } from "@/lib/api-client";
import { createInvitation, listUsers, updateUserStatus } from "./admin-api";

afterEach(() => {
  vi.doUnmock("./demo-admin-data");
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("administrator API", () => {
  it("requests the documented cursor page and forwards its AbortSignal", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();

    await listUsers({ cursor: "signed cursor/value", limit: 37, signal: controller.signal });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/admin/users?cursor=signed+cursor%2Fvalue&limit=37",
      expect.objectContaining({
        credentials: "same-origin",
        signal: controller.signal,
      }),
    );
  });

  it("PATCHes only the status to an encoded user endpoint", async () => {
    const updated = {
      id: "user/id",
      username: "member",
      role: "member",
      status: "disabled",
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    const fetcher = vi.fn().mockResolvedValue(Response.json(updated));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();

    await updateUserStatus("user/id", "disabled", controller.signal);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/admin/users/user%2Fid/status",
      expect.objectContaining({
        method: "PATCH",
        credentials: "same-origin",
        body: JSON.stringify({ status: "disabled" }),
        signal: controller.signal,
      }),
    );
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(Object.keys(JSON.parse(String(init.body)))).toEqual(["status"]);
  });

  it("POSTs only expiresInHours when creating an invitation", async () => {
    const invitation = {
      id: "00000000-0000-4000-8000-000000000020",
      inviteUrl: "https://fitgrid.example/invite/token",
      expiresAt: "2026-09-03T00:00:00.000Z",
    };
    const fetcher = vi.fn().mockResolvedValue(Response.json(invitation, { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();

    await expect(createInvitation(24, controller.signal)).resolves.toEqual(invitation);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/admin/invitations",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ expiresInHours: 24 }),
        signal: controller.signal,
      }),
    );
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(Object.keys(JSON.parse(String(init.body)))).toEqual(["expiresInHours"]);
  });

  it("preserves the public error envelope, request ID, field errors, and retry delay", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      {
        code: "VALIDATION_FAILED",
        message: "有效期超出范围",
        requestId: "01ADMIN",
        fieldErrors: { expiresInHours: ["必须介于 1 和 168 之间"] },
      },
      { status: 429, headers: { "Retry-After": "19" } },
    )));

    await expect(createInvitation(169)).rejects.toMatchObject({
      status: 429,
      code: "VALIDATION_FAILED",
      message: "有效期超出范围",
      requestId: "01ADMIN",
      fieldErrors: { expiresInHours: ["必须介于 1 和 168 之间"] },
      retryAfterSeconds: 19,
    });
  });

  it("uses a deterministic mutable repository only in local UI demo mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
    vi.stubEnv("NEXT_PUBLIC_APP_BASE_PATH", "/fitgrid");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const first = await listUsers({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe("demo:1");
    expect(first.items[0]).toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      username: "demo",
      role: "admin",
      status: "active",
      createdAt: "2026-09-01T00:00:00.000Z",
    });

    const second = await listUsers({ cursor: first.nextCursor!, limit: 1 });
    const changed = await updateUserStatus(second.items[0].id, "disabled");
    expect(changed.status).toBe("disabled");
    expect((await listUsers({ cursor: "demo:1", limit: 1 })).items[0].status).toBe("disabled");

    const invitation = await createInvitation(24);
    expect(new URL(invitation.inviteUrl).pathname).toMatch(
      /^\/fitgrid\/invite\/demo-admin-invitation-\d+$/,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never initializes demo administrator data when the production module loads", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "0");
    const initializeDemoData = vi.fn();
    vi.doMock("./demo-admin-data", () => {
      initializeDemoData();
      return {};
    });

    await import("./admin-api");

    expect(initializeDemoData).not.toHaveBeenCalled();
  });

  it("does not let a production demo flag bypass the authoritative API", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
    const fetcher = vi.fn().mockResolvedValue(Response.json(
      { code: "FORBIDDEN", message: "需要管理员权限", requestId: "01REALADMIN" },
      { status: 403 },
    ));
    vi.stubGlobal("fetch", fetcher);

    const error = await listUsers().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClientApiError);
    expect(error).toMatchObject({ status: 403, requestId: "01REALADMIN" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
