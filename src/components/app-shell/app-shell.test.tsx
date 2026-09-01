// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppShell } from "./app-shell";

afterEach(cleanup);

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
});
