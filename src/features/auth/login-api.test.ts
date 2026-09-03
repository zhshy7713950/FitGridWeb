import { afterEach, expect, it, vi } from "vitest";

import { login, logout } from "./login-api";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("uses local demo credentials without contacting an authentication server", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);

  await expect(login("demo", "fitgrid-demo")).resolves.toMatchObject({
    user: { username: "demo", role: "admin", status: "active" },
  });
  await expect(login("demo", "wrong-password")).rejects.toMatchObject({
    status: 401,
    code: "UNAUTHORIZED",
  });
  await expect(logout()).resolves.toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});
