import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getOptionalSession, redirect } = vi.hoisted(() => ({
  getOptionalSession: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/server/auth/session", () => ({ getOptionalSession }));

import ProtectedLayout from "./(protected)/layout";
import LoginPage from "./login/page";
import HomePage from "./page";

const user = {
  id: "user-1",
  username: "admin",
  role: "admin" as const,
  status: "active" as const,
};

describe("server redirects with a configured Next.js base path", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    redirect.mockClear();
    getOptionalSession.mockReset();
    process.env.NEXT_PUBLIC_APP_BASE_PATH = "/fitgrid";
    delete process.env.NEXT_PUBLIC_UI_DEMO_MODE;
  });

  it("lets Next.js prefix the anonymous home redirect exactly once", async () => {
    getOptionalSession.mockResolvedValue(null);

    await expect(HomePage()).rejects.toThrow("redirect:/login");
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("lets Next.js prefix the authenticated login redirect exactly once", async () => {
    getOptionalSession.mockResolvedValue(user);

    await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "redirect:/grids",
    );
    expect(redirect).toHaveBeenCalledWith("/grids");
  });

  it("lets Next.js prefix the protected-route login redirect exactly once", async () => {
    getOptionalSession.mockResolvedValue(null);

    await expect(ProtectedLayout({ children: null })).rejects.toThrow(
      "redirect:/login?returnTo=%2Fgrids",
    );
    expect(redirect).toHaveBeenCalledWith("/login?returnTo=%2Fgrids");
  });

  it("opens protected UI routes without a database only in local demo mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
    vi.stubEnv("NODE_ENV", "development");

    const result = await ProtectedLayout({ children: null });

    expect(getOptionalSession).not.toHaveBeenCalled();
    expect(result.props.user).toMatchObject({ username: "demo", role: "admin" });
  });
});
