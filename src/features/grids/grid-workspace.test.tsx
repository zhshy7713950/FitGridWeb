// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import type { GridTradeListController } from "./use-grid-trades";
import { GridWorkspaceView } from "./grid-workspace";

const product = {
  id: "g1",
  productName: "黄金ETF网格",
  productCode: "518880",
  maxPrice: "6.9200",
  perShare: "1500",
  isShort: false,
  algorithmVersion: "android-v2.1.0" as const,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:30:00Z",
};

function controller(
  patch: Partial<GridTradeListController> = {},
): GridTradeListController {
  return {
    query: "",
    setQuery: vi.fn(),
    clearQuery: vi.fn(),
    items: [product],
    nextCursor: null,
    initialLoading: false,
    refreshing: false,
    pageLoading: false,
    initialError: "",
    pageError: "",
    refresh: vi.fn().mockResolvedValue(undefined),
    loadMore: vi.fn().mockResolvedValue(undefined),
    retryPage: vi.fn().mockResolvedValue(undefined),
    ...patch,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  document.body.style.removeProperty("overflow");
});

it("renders one responsive product table with richer desktop fields", () => {
  render(<GridWorkspaceView controller={controller()} />);

  expect(
    screen.getByText(/^Grid strategies · 已载入 1 项$/),
  ).toBeInTheDocument();

  const table = screen.getByRole("table", { name: "网格产品" });
  expect(within(table).getByText("当前账号的网格产品")).toBeInTheDocument();
  for (const heading of ["产品名称", "产品代码", "方向", "最高价", "每份金额", "更新时间"]) {
    expect(within(table).getByRole("columnheader", { name: heading })).toBeInTheDocument();
  }
  for (const value of ["黄金ETF网格", "518880", "做多", "6.9200", "1,500", "09-01 08:30"]) {
    expect(within(table).getByText(value)).toBeInTheDocument();
  }
  expect(within(table).getByText("09-01 08:30").closest("time")).toHaveAttribute(
    "datetime",
    "2026-09-01T00:30:00Z",
  );
  expect(screen.queryByRole("list", { name: "网格产品卡片" })).not.toBeInTheDocument();
  expect(within(table).queryByText("android-v2.1.0")).not.toBeInTheDocument();
});

it("links each product name to its stable detail route and offers all account actions from the heading", async () => {
  render(<GridWorkspaceView controller={controller()} />);

  expect(screen.getByRole("link", { name: "黄金ETF网格" })).toHaveAttribute(
    "href",
    `/grids/${product.id}`,
  );
  expect(screen.getByRole("link", { name: "新建产品" })).toHaveAttribute(
    "href",
    "/grids/new",
  );
  expect(screen.getByRole("link", { name: "导入数据" })).toHaveAttribute(
    "href",
    "/grids/import",
  );
  await userEvent.click(screen.getByRole("button", { name: "数据备份" }));
  expect(screen.getByRole("dialog", { name: "数据备份" })).toBeInTheDocument();
});

it("prefixes the import action exactly once for the deployed base path", () => {
  vi.stubEnv("NEXT_PUBLIC_APP_BASE_PATH", "/fitgrid");
  render(<GridWorkspaceView controller={controller()} />);

  expect(screen.getByRole("link", { name: "导入数据" })).toHaveAttribute(
    "href",
    "/fitgrid/grids/import",
  );
  expect(screen.getByRole("link", { name: "导入数据" })).not.toHaveAttribute(
    "href",
    "/fitgrid/fitgrid/grids/import",
  );
});

it("keeps maximum-length codes and decimal values intact in the shared table", () => {
  const maximumProduct = {
    ...product,
    productCode: "A".repeat(64),
    maxPrice: "12345678901234567890.1234567890",
    perShare: "99999999999999999999.9999999999",
  };
  render(<GridWorkspaceView controller={controller({ items: [maximumProduct] })} />);

  const table = screen.getByRole("table", { name: "网格产品" });
  for (const exactValue of [
    "A".repeat(64),
    "12,345,678,901,234,567,890.1234567890",
    "99,999,999,999,999,999,999.9999999999",
  ]) {
    expect(within(table).getByText(exactValue, { exact: true })).toBeVisible();
  }
});

it("renders initial loading and initial failure states with retry", async () => {
  const value = controller({ items: [], initialLoading: true });
  const { rerender } = render(<GridWorkspaceView controller={value} />);

  expect(screen.getByRole("status")).toHaveTextContent("正在加载产品…");

  rerender(
    <GridWorkspaceView
      controller={controller({
        items: [],
        initialLoading: false,
        initialError: "加载产品失败",
        refresh: value.refresh,
      })}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("加载产品失败");
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(value.refresh).toHaveBeenCalledTimes(1);
});

it("keeps existing rows visible when refresh fails and exposes a retry", async () => {
  const value = controller({ initialError: "加载产品失败" });
  render(<GridWorkspaceView controller={value} />);

  const table = screen.getByRole("table", { name: "网格产品" });
  expect(within(table).getByText("黄金ETF网格")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("加载产品失败");
  await userEvent.click(screen.getByRole("button", { name: "重试刷新" }));
  expect(value.refresh).toHaveBeenCalledTimes(1);
});

it("shows a centered live refresh status and disables duplicate refresh", async () => {
  const value = controller({ initialLoading: true, refreshing: true });
  render(<GridWorkspaceView controller={value} />);

  expect(screen.getByText("黄金ETF网格")).toBeInTheDocument();
  expect(screen.getByRole("status", { name: "正在刷新…" })).toBeInTheDocument();
  const refresh = screen.getByRole("button", { name: "刷新" });
  expect(refresh).toBeDisabled();
  expect(refresh).toHaveAttribute("aria-disabled", "true");
  expect(refresh).toHaveAttribute("aria-busy", "true");
  await userEvent.click(refresh);
  expect(value.refresh).not.toHaveBeenCalled();
});

it("keeps the refresh overlay visible briefly for an instant request then removes it", async () => {
  vi.useFakeTimers();
  const value = controller();
  render(<GridWorkspaceView controller={value} />);

  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await act(async () => {
    await Promise.resolve();
  });

  expect(value.refresh).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status", { name: "正在刷新…" })).toBeInTheDocument();

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  expect(screen.queryByRole("status", { name: "正在刷新…" })).not.toBeInTheDocument();
});

it("ignores a rapid duplicate refresh and removes feedback after a rejected request", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockRejectedValue(new Error("offline"));
  render(<GridWorkspaceView controller={controller({ refresh })} />);

  const button = screen.getByRole("button", { name: "刷新" });
  fireEvent.click(button);
  fireEvent.click(button);
  await act(async () => {
    await Promise.resolve();
  });

  expect(refresh).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status", { name: "正在刷新…" })).toBeInTheDocument();

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  expect(screen.queryByRole("status", { name: "正在刷新…" })).not.toBeInTheDocument();
});

it("cancels its refresh feedback timer when the product view unmounts", () => {
  vi.useFakeTimers();
  const { unmount } = render(<GridWorkspaceView controller={controller()} />);
  const setTimeoutSpy = vi.spyOn(window, "setTimeout");
  const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");

  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  const refreshTimerIndex = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 500);
  expect(refreshTimerIndex).toBeGreaterThanOrEqual(0);
  const refreshTimer = setTimeoutSpy.mock.results[refreshTimerIndex]?.value;

  unmount();

  expect(clearTimeoutSpy).toHaveBeenCalledWith(refreshTimer);
});

it("offers create, import and backup for an empty account but only clearing for an empty search", async () => {
  const emptyAccount = controller({ items: [] });
  const { rerender } = render(
    <GridWorkspaceView controller={emptyAccount} />,
  );
  expect(screen.getByText("还没有网格产品")).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: "新建产品" })).toHaveLength(2);
  const accountEmpty = screen.getByRole("region", { name: "账号产品空状态" });
  expect(within(accountEmpty).getByRole("link", { name: "导入数据" })).toHaveAttribute(
    "href",
    "/grids/import",
  );
  await userEvent.click(within(accountEmpty).getByRole("button", { name: "数据备份" }));
  expect(screen.getByRole("dialog", { name: "数据备份" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "关闭数据备份" }));

  const emptySearch = controller({ items: [], query: "gold" });
  rerender(
    <GridWorkspaceView controller={emptySearch} />,
  );
  expect(screen.getByText("没有匹配的产品")).toBeInTheDocument();
  const searchEmpty = screen.getByRole("region", { name: "搜索结果空状态" });
  expect(within(searchEmpty).queryByRole("link")).not.toBeInTheDocument();
  const clear = within(searchEmpty).getByRole("button", { name: "清除搜索" });
  expect(within(searchEmpty).getAllByRole("button")).toEqual([clear]);
  await userEvent.click(clear);
  expect(emptySearch.clearQuery).toHaveBeenCalledTimes(1);
});

it("treats whitespace-only input as an unfiltered empty account", () => {
  render(
    <GridWorkspaceView controller={controller({ items: [], query: "   " })} />,
  );

  expect(screen.getByText("还没有网格产品")).toBeInTheDocument();
  expect(screen.queryByText("没有匹配的产品")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "清除搜索" })).not.toBeInTheDocument();
});

it("forwards search edits and clears an active query", async () => {
  const value = controller({ query: "gold" });
  render(<GridWorkspaceView controller={value} />);

  const search = screen.getByRole("searchbox", { name: "搜索产品名称或代码" });
  await userEvent.type(search, "en");
  expect(value.setQuery).toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
  expect(value.clearQuery).toHaveBeenCalledTimes(1);
});

it("loads near the bottom of the shared scroll viewport", () => {
  const value = controller({ nextCursor: "c2" });
  render(<GridWorkspaceView controller={value} />);
  const viewport = screen.getByRole("region", { name: "网格产品列表" });
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, value: 359 },
  });

  fireEvent.scroll(viewport);
  expect(value.loadMore).not.toHaveBeenCalled();

  Object.defineProperty(viewport, "scrollTop", { configurable: true, value: 360 });
  fireEvent.scroll(viewport);
  expect(value.loadMore).toHaveBeenCalledTimes(1);
});

it("supports keyboard load more and page retry", async () => {
  const value = controller({ nextCursor: "c2" });
  const { rerender } = render(<GridWorkspaceView controller={value} />);
  const loadMore = screen.getByRole("button", { name: "加载更多" });
  loadMore.focus();
  await userEvent.keyboard("{Enter}");
  expect(value.loadMore).toHaveBeenCalledTimes(1);

  const retryValue = controller({ nextCursor: "c2", pageError: "加载更多失败" });
  rerender(<GridWorkspaceView controller={retryValue} />);
  expect(screen.getByText("加载更多失败")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "重试加载更多" }));
  expect(retryValue.retryPage).toHaveBeenCalledTimes(1);
});

it("keeps busy pagination focusable without dispatching another load", async () => {
  const value = controller({ nextCursor: "c2", pageLoading: true });
  render(<GridWorkspaceView controller={value} />);

  const loadMore = screen.getByRole("button", { name: "正在加载…" });
  expect(loadMore).not.toBeDisabled();
  expect(loadMore).toHaveAttribute("aria-disabled", "true");
  expect(loadMore).toHaveAttribute("aria-busy", "true");

  loadMore.focus();
  expect(loadMore).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await userEvent.click(loadMore);
  expect(value.loadMore).not.toHaveBeenCalled();
});

it("falls back to the product code when the product name is blank", () => {
  const unnamed = { ...product, productName: "", productCode: "510300" };
  render(<GridWorkspaceView controller={controller({ items: [unnamed] })} />);

  const table = screen.getByRole("table", { name: "网格产品" });
  expect(within(table).getAllByText("510300")).toHaveLength(2);
});

it("does not start a real request when only the pure view is rendered", () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  render(<GridWorkspaceView controller={controller()} />);

  expect(fetchSpy).not.toHaveBeenCalled();
});
