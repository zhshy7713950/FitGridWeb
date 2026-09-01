// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell";

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
});
