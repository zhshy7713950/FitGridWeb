// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { DataManagementWorkspace } from "./data-management-workspace";

afterEach(cleanup);

it("presents the complete data vault under a standalone data-management page", () => {
  render(<DataManagementWorkspace initialBackups={[]} />);

  expect(screen.getByRole("heading", { level: 1, name: "数据管理" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 2, name: "数据保险库" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "创建备份" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "上传并检查" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "历史备份" })).toBeInTheDocument();
});
