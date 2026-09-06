// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Link from "next/link";
import { afterEach, expect, it, vi } from "vitest";

import { MobileActionMenu } from "./mobile-action-menu";

afterEach(cleanup);

it("closes after an action and restores focus after Escape", async () => {
  const user = userEvent.setup();
  const refresh = vi.fn();
  render(
    <>
      <MobileActionMenu label="更多操作">
        <button type="button" onClick={refresh}>刷新</button>
        <Link href="/grids/import">导入数据</Link>
      </MobileActionMenu>
      <button type="button">页面外按钮</button>
    </>,
  );

  const trigger = screen.getByRole("button", { name: "更多操作" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("group", { name: "更多操作菜单" })).not.toBeInTheDocument();

  await user.click(trigger);
  const menu = screen.getByRole("group", { name: "更多操作菜单" });
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(within(menu).getByRole("button", { name: "刷新" })).toHaveFocus();

  await user.click(within(menu).getByRole("button", { name: "刷新" }));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("group", { name: "更多操作菜单" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();

  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("group", { name: "更多操作菜单" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("closes when focus or pointer moves outside", async () => {
  const user = userEvent.setup();
  render(
    <>
      <MobileActionMenu label="更多操作">
        <button type="button">刷新</button>
      </MobileActionMenu>
      <button type="button">页面外按钮</button>
    </>,
  );

  const trigger = screen.getByRole("button", { name: "更多操作" });
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "页面外按钮" }));
  expect(screen.queryByRole("group", { name: "更多操作菜单" })).not.toBeInTheDocument();

  await user.click(trigger);
  await user.tab();
  await user.tab();
  expect(screen.queryByRole("group", { name: "更多操作菜单" })).not.toBeInTheDocument();
});
