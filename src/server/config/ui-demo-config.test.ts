import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("refuses a production image even when every account demo module is present", async () => {
  const [invitationDemo, accountDemo, adminDemo] = await Promise.all([
    import("../../features/invitations/demo-invitation-data"),
    import("../../features/account/demo-account-data"),
    import("../../features/admin/demo-admin-data"),
  ]);
  expect(typeof invitationDemo.getDemoInvitationStatus).toBe("function");
  expect(typeof accountDemo.changeDemoPassword).toBe("function");
  expect(typeof adminDemo.listDemoUsers).toBe("function");

  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");

  await expect(import("../../../next.config")).rejects.toThrow(
    "UI demo mode is development-only",
  );
});

it("keeps cached account demo adapters behind authoritative production APIs", async () => {
  await Promise.all([
    import("../../features/invitations/demo-invitation-data"),
    import("../../features/account/demo-account-data"),
    import("../../features/admin/demo-admin-data"),
  ]);
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
  vi.stubEnv("NEXT_PUBLIC_APP_BASE_PATH", "/fitgrid");
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/auth/change-password")) return new Response(null, { status: 204 });
    if (url.endsWith("/admin/users?limit=1")) {
      return Response.json({ items: [], nextCursor: null });
    }
    return Response.json({ status: "valid", expiresAt: null });
  });
  vi.stubGlobal("fetch", fetcher);

  const [{ getInvitationStatus }, { changePassword }, { listUsers }] = await Promise.all([
    import("../../features/invitations/invitation-api"),
    import("../../features/account/account-api"),
    import("../../features/admin/admin-api"),
  ]);
  await getInvitationStatus("valid-demo-invitation-token-000001");
  await changePassword("fitgrid-demo", "replacement-secret");
  await listUsers({ limit: 1 });

  expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
    "/fitgrid/api/v1/invitations/valid-demo-invitation-token-000001",
    "/fitgrid/api/v1/auth/change-password",
    "/fitgrid/api/v1/admin/users?limit=1",
  ]);
});
