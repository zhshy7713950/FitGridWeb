// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { usePathname } = vi.hoisted(() => ({
  usePathname: vi.fn(() => "/grids"),
}));

vi.mock("next/navigation", () => ({ usePathname }));

import { AppShell } from "./app-shell";

beforeEach(() => usePathname.mockReturnValue("/grids"));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("AppShell", () => {
  it("exposes one application navigation and the current account", () => {
    render(
      <AppShell user={{ id: "u1", username: "admin", role: "admin", status: "active" }}>
        <h1>网格产品</h1>
      </AppShell>,
    );

    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getByRole("main")).toHaveTextContent("网格产品");
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByText("管理员")).toBeInTheDocument();
    expect(screen.queryByText("导入")).not.toBeInTheDocument();
  });

  it("keeps the account bar and primary navigation before page content", () => {
    render(
      <AppShell user={{ id: "u1", username: "admin", role: "admin", status: "active" }}>
        <h1>网格产品</h1>
      </AppShell>,
    );

    const header = screen.getByRole("banner");
    const navigation = screen.getByRole("navigation", { name: "主导航" });
    const main = screen.getByRole("main");

    expect(header.compareDocumentPosition(navigation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(navigation.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps a long username accessible with its role and logout control", () => {
    const username = "a".repeat(64);

    render(
      <AppShell user={{ id: "u1", username, role: "member", status: "active" }}>
        <h1>网格产品</h1>
      </AppShell>,
    );

    expect(screen.getByTitle(username)).toHaveTextContent(username);
    expect(screen.getByText("普通用户")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();
  });

  it("shows account navigation to members and admin navigation only to administrators", () => {
    const { rerender } = render(
      <AppShell user={{ id: "u1", username: "member", role: "member", status: "active" }}>
        <h1>网格产品</h1>
      </AppShell>,
    );

    expect(screen.getByRole("link", { name: "网格产品" })).toHaveAttribute("href", "/grids");
    expect(screen.getByRole("link", { name: "安全设置" })).toHaveAttribute(
      "href",
      "/settings/security",
    );
    expect(screen.queryByRole("link", { name: "账号管理" })).not.toBeInTheDocument();

    rerender(
      <AppShell user={{ id: "u2", username: "admin", role: "admin", status: "active" }}>
        <h1>网格产品</h1>
      </AppShell>,
    );

    expect(screen.getByRole("link", { name: "账号管理" })).toHaveAttribute("href", "/admin");
  });

  it.each([
    ["/grids", "网格产品"],
    ["/grids/grid-1/edit", "网格产品"],
    ["/settings/security", "安全设置"],
    ["/admin", "账号管理"],
  ])("marks only the matching navigation link current at %s", (pathname, currentLabel) => {
    usePathname.mockReturnValue(pathname);

    render(
      <AppShell user={{ id: "u1", username: "admin", role: "admin", status: "active" }}>
        <h1>当前页面</h1>
      </AppShell>,
    );

    expect(screen.getByRole("link", { current: "page" })).toHaveAccessibleName(currentLabel);
    expect(screen.getAllByRole("link").filter((link) => link.hasAttribute("aria-current"))).toHaveLength(1);
  });

  it.each(["/settings", "/settings/security/", "/admin/users", "/invite/token"])(
    "does not mark an unrelated navigation link current at %s",
    (pathname) => {
      usePathname.mockReturnValue(pathname);

      render(
        <AppShell user={{ id: "u1", username: "admin", role: "admin", status: "active" }}>
          <h1>当前页面</h1>
        </AppShell>,
      );

      expect(screen.queryByRole("link", { current: "page" })).not.toBeInTheDocument();
    },
  );

  it("matches a configured base-path pathname after removing the base path once", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_BASE_PATH", "/fitgrid");
    usePathname.mockReturnValue("/fitgrid/settings/security");

    const { rerender } = render(
      <AppShell user={{ id: "u1", username: "admin", role: "admin", status: "active" }}>
        <h1>安全设置</h1>
      </AppShell>,
    );

    expect(screen.getByRole("link", { current: "page" })).toHaveAccessibleName("安全设置");

    usePathname.mockReturnValue("/fitgrid/fitgrid/grids");
    rerender(
      <AppShell user={{ id: "u1", username: "admin", role: "admin", status: "active" }}>
        <h1>未知页面</h1>
      </AppShell>,
    );

    expect(screen.queryByRole("link", { current: "page" })).not.toBeInTheDocument();
  });
});
