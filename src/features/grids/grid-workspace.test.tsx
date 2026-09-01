// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  updatedAt: "2026-09-01T00:00:00Z",
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
  vi.unstubAllGlobals();
});

it("renders the four App fields in semantic desktop and mobile representations", () => {
  render(<GridWorkspaceView controller={controller()} />);

  expect(
    screen.getByText(/^Grid strategies · 已载入 1 项$/),
  ).toBeInTheDocument();

  const table = screen.getByRole("table", { name: "网格产品" });
  expect(within(table).getByText("当前账号的网格产品")).toBeInTheDocument();
  for (const heading of ["产品名称", "产品代码", "最高价", "每份金额"]) {
    expect(within(table).getByRole("columnheader", { name: heading })).toBeInTheDocument();
  }
  for (const value of ["黄金ETF网格", "518880", "6.9200", "1,500"]) {
    expect(within(table).getByText(value)).toBeInTheDocument();
  }

  const cards = screen.getByRole("list", { name: "网格产品卡片" });
  for (const value of ["黄金ETF网格", "518880", "6.9200", "1,500"]) {
    expect(within(cards).getByText(value)).toBeInTheDocument();
  }
  for (const label of ["产品代码", "最高价", "每份金额"]) {
    expect(within(cards).getByText(label)).toBeInTheDocument();
  }
});

it("keeps maximum-length mobile codes and decimal values intact", () => {
  const maximumProduct = {
    ...product,
    productCode: "A".repeat(64),
    maxPrice: "12345678901234567890.1234567890",
    perShare: "99999999999999999999.9999999999",
  };
  render(<GridWorkspaceView controller={controller({ items: [maximumProduct] })} />);

  const cards = screen.getByRole("list", { name: "网格产品卡片" });
  for (const exactValue of [
    "A".repeat(64),
    "12,345,678,901,234,567,890.1234567890",
    "99,999,999,999,999,999,999.9999999999",
  ]) {
    expect(within(cards).getByText(exactValue, { exact: true })).toBeVisible();
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

it("keeps retained rows visible and exposes a focusable live refresh state", async () => {
  const value = controller({ initialLoading: true, refreshing: true });
  render(<GridWorkspaceView controller={value} />);

  expect(screen.getAllByText("黄金ETF网格")).toHaveLength(2);
  const refresh = screen.getByRole("button", { name: "正在刷新…" });
  expect(refresh).not.toBeDisabled();
  expect(refresh).toHaveAttribute("aria-disabled", "true");
  expect(refresh).toHaveAttribute("aria-busy", "true");
  expect(within(refresh).getByText("正在刷新…")).toHaveAttribute("aria-live", "polite");

  refresh.focus();
  expect(refresh).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await userEvent.click(refresh);
  expect(value.refresh).not.toHaveBeenCalled();
});

it("distinguishes an empty account from an empty search", () => {
  const { rerender } = render(
    <GridWorkspaceView controller={controller({ items: [] })} />,
  );
  expect(screen.getByText("还没有网格产品")).toBeInTheDocument();

  rerender(
    <GridWorkspaceView controller={controller({ items: [], query: "gold" })} />,
  );
  expect(screen.getByText("没有匹配的产品")).toBeInTheDocument();
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
  const cards = screen.getByRole("list", { name: "网格产品卡片" });
  expect(within(cards).getAllByText("510300")).toHaveLength(2);
});

it("does not start a real request when only the pure view is rendered", () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  render(<GridWorkspaceView controller={controller()} />);

  expect(fetchSpy).not.toHaveBeenCalled();
});
