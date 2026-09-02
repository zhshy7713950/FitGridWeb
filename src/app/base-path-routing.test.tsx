import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

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
vi.mock("@/features/invitations/invitation-page", () => ({
  InvitationPage: ({ token }: { token: string }) => <p>invite:{token}</p>,
}));
vi.mock("@/features/admin/admin-workspace", () => ({
  AdminWorkspace: ({ currentUserId }: { currentUserId: string }) => (
    <p>admin-workspace:{currentUserId}</p>
  ),
}));

import ProtectedLayout from "./(protected)/layout";
import AdminPage from "./(protected)/admin/page";
import InvitePage from "./invite/[token]/page";
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

  it("renders only a browser redirect surface for an anonymous protected route", async () => {
    getOptionalSession.mockResolvedValue(null);

    const result = await ProtectedLayout({ children: <p>受保护产品内容</p> });
    const markup = renderToStaticMarkup(result);

    expect(markup).toContain("正在进入登录页");
    expect(markup).not.toContain("受保护产品内容");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("opens protected UI routes without a database only in local demo mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
    vi.stubEnv("NODE_ENV", "development");

    const result = await ProtectedLayout({ children: null });

    expect(getOptionalSession).not.toHaveBeenCalled();
    expect(result.props.user).toMatchObject({ username: "demo", role: "admin" });
  });

  it("awaits public invitation params without entering the protected layout", async () => {
    const result = await InvitePage({ params: Promise.resolve({ token: "public-token" }) });
    const markup = renderToStaticMarkup(result);

    expect(markup).toContain("invite:public-token");
    expect(getOptionalSession).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("preserves /admin when an anonymous request reaches the server role guard", async () => {
    getOptionalSession.mockResolvedValue(null);

    await expect(AdminPage()).rejects.toThrow("redirect:/login?returnTo=%2Fadmin");
    expect(redirect).toHaveBeenCalledWith("/login?returnTo=%2Fadmin");
  });

  it("redirects a member away without rendering or disclosing the admin workspace", async () => {
    getOptionalSession.mockResolvedValue({ ...user, id: "member-1", role: "member" });

    await expect(AdminPage()).rejects.toThrow("redirect:/grids");
    expect(redirect).toHaveBeenCalledWith("/grids");
  });

  it("renders the admin workspace only after the server role guard passes", async () => {
    getOptionalSession.mockResolvedValue(user);

    const markup = renderToStaticMarkup(await AdminPage());

    expect(markup).toContain("admin-workspace:user-1");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("uses the development-only demo admin without consulting the production session", async () => {
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
    vi.stubEnv("NODE_ENV", "development");

    const markup = renderToStaticMarkup(await AdminPage());

    expect(markup).toContain("admin-workspace:00000000-0000-4000-8000-000000000001");
    expect(getOptionalSession).not.toHaveBeenCalled();
  });
});
