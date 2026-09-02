// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientApiError } from "@/lib/api-client";

import type { GridItem, GridTradeDetail } from "./types";

const api = vi.hoisted(() => ({
  getGridTrade: vi.fn(),
  recalculateGridTrade: vi.fn(),
}));

vi.mock("./grid-api", () => api);

import { GridDetail, GridDetailView } from "./grid-detail";

const items: GridItem[] = [
  {
    sequence: 1,
    gridType: 1,
    gear: "100",
    buyPrice: "6.920",
    buyCount: "300",
    buyAmount: "2076.000",
    sellPrice: "7.266",
    sellCount: "298",
    sellAmount: "2165.268",
    profitAmount: "89.268",
    profitRate: "4.300",
    keepProfit: "14.532",
    keepCount: "2",
  },
  {
    sequence: 2,
    gridType: 2,
    gear: "85",
    buyPrice: "5.882",
    buyCount: "400",
    buyAmount: "2352.800",
    sellPrice: "6.920",
    sellCount: "400",
    sellAmount: "2768.000",
    profitAmount: "415.200",
    profitRate: "17.647",
    keepProfit: "0",
    keepCount: "0",
  },
  {
    sequence: 3,
    gridType: 3,
    gear: "70",
    buyPrice: "4.844",
    buyCount: "500",
    buyAmount: "2422.000",
    sellPrice: "6.920",
    sellCount: "500",
    sellAmount: "3460.000",
    profitAmount: "1038.000",
    profitRate: "42.857",
    keepProfit: "0",
    keepCount: "0",
  },
];

const detail: GridTradeDetail = {
  id: "11111111-1111-4111-8111-111111111111",
  productName: "黄金 ETF",
  productCode: "518880",
  maxPrice: "6.92",
  perShare: "2000",
  isShort: false,
  algorithmVersion: "android-v2.1.0",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  input: {
    productName: "黄金 ETF",
    productCode: "518880",
    maxPrice: "6.92",
    minTradeQuantity: "100",
    gearAmplitude: "5",
    perShare: "2000",
    keepShare: 2,
    increaseAmplitude: 5,
    mediumAmplitude: 15,
    bigAmplitude: 30,
    maxAmplitude: 60,
    isShort: false,
    category: "ETF",
    sortOrder: 0,
    algorithmVersion: "android-v2.1.0",
  },
  calculation: {
    items,
    totalBuyAmount: "6850.800",
    totalProfitAmount: "1542.468",
    totalProfitRate: "22.515",
  },
};

afterEach(cleanup);

beforeEach(() => {
  api.getGridTrade.mockReset();
  api.recalculateGridTrade.mockReset();
});

describe("GridDetailView", () => {
  it("renders every financial column, semantic grid labels, and calculation totals", () => {
    render(<GridDetailView detail={detail} onRecalculate={vi.fn()} onDelete={vi.fn()} />);

    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual([
      "序号",
      "种类",
      "档位",
      "买入价格",
      "买入数量",
      "买入金额",
      "卖出价格",
      "卖出数量",
      "卖出金额",
      "盈利金额",
      "盈利比例",
      "本期留存利润",
      "本期留存数量",
    ]);
    expect(screen.getByText("小网")).toBeInTheDocument();
    expect(screen.getByText("中网")).toBeInTheDocument();
    expect(screen.getByText("大网")).toBeInTheDocument();
    const summary = screen.getByRole("row", { name: /计算汇总/ });
    expect(summary).toHaveTextContent(/买入总金额\s*6,850\.800/);
    expect(summary).toHaveTextContent(/总盈利\s*1,542\.468/);
    expect(summary).toHaveTextContent(/总盈利率\s*22\.515%/);
  });

  it("opens a row and moves through calculation items with bounded controls", async () => {
    const user = userEvent.setup();
    render(<GridDetailView detail={detail} onRecalculate={vi.fn()} onDelete={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "查看第 1 笔明细" }));
    let dialog = screen.getByRole("dialog", { name: "网格行明细" });
    expect(dialog).toHaveTextContent("1 / 3");
    expect(within(dialog).getByRole("button", { name: "上一笔" })).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "下一笔" }));
    dialog = screen.getByRole("dialog", { name: "网格行明细" });
    expect(dialog).toHaveTextContent("2 / 3");
    expect(screen.getByRole("button", { name: "查看第 2 笔明细" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(within(dialog).getByRole("button", { name: "下一笔" }));
    expect(dialog).toHaveTextContent("3 / 3");
    expect(within(dialog).getByRole("button", { name: "下一笔" })).toBeDisabled();
  });

  it("shows sell columns and inspector values before buy values for short products", async () => {
    const user = userEvent.setup();
    render(
      <GridDetailView
        detail={{ ...detail, isShort: true, input: { ...detail.input, isShort: true } }}
        onRecalculate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers.indexOf("卖出价格")).toBeLessThan(headers.indexOf("买入价格"));

    await user.click(screen.getByRole("button", { name: "查看第 1 笔明细" }));
    const dialog = screen.getByRole("dialog", { name: "网格行明细" });
    const labels = within(dialog).getAllByText(/价格|数量/).map((node) => node.textContent);
    expect(labels.indexOf("卖出价格")).toBeLessThan(labels.indexOf("买入价格"));
    expect(dialog).toHaveTextContent("7.266");
    expect(dialog).toHaveTextContent("6.920");
  });

  it("moves focus into the inspector and closes it with Escape", async () => {
    const user = userEvent.setup();
    render(<GridDetailView detail={detail} onRecalculate={vi.fn()} onDelete={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "查看第 1 笔明细" }));
    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "网格行明细" })).not.toBeInTheDocument();
  });
});

describe("GridDetail controller", () => {
  it("loads the authoritative detail once on mount", async () => {
    api.getGridTrade.mockResolvedValue(detail);

    render(<GridDetail id={detail.id} />);

    expect(await screen.findByRole("heading", { name: "黄金 ETF" })).toBeInTheDocument();
    expect(api.getGridTrade).toHaveBeenCalledTimes(1);
    expect(api.getGridTrade).toHaveBeenCalledWith(detail.id, expect.any(AbortSignal));
  });

  it("replaces the displayed calculation after a successful authoritative recalculation", async () => {
    const recalculated = {
      ...detail,
      updatedAt: "2026-09-02T01:00:00.000Z",
      calculation: {
        ...detail.calculation,
        totalProfitAmount: "2000.000",
      },
    };
    api.getGridTrade.mockResolvedValue(detail);
    api.recalculateGridTrade.mockResolvedValue(recalculated);
    render(<GridDetail id={detail.id} />);

    await screen.findByRole("heading", { name: "黄金 ETF" });
    await userEvent.click(screen.getByRole("button", { name: "重新计算" }));

    await waitFor(() => expect(screen.getByRole("row", { name: /计算汇总/ })).toHaveTextContent("2,000.000"));
  });

  it("preserves the current calculation after failure and allows retry", async () => {
    api.getGridTrade.mockResolvedValue(detail);
    api.recalculateGridTrade
      .mockRejectedValueOnce(new ClientApiError(503, "UPSTREAM", "计算服务暂不可用", "req-4"))
      .mockResolvedValueOnce({
        ...detail,
        calculation: { ...detail.calculation, totalProfitAmount: "1800.000" },
      });
    render(<GridDetail id={detail.id} />);

    await screen.findByRole("heading", { name: "黄金 ETF" });
    await userEvent.click(screen.getByRole("button", { name: "重新计算" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("计算服务暂不可用");
    expect(screen.getByRole("alert")).toHaveTextContent("请求 ID：req-4");
    expect(screen.getByRole("row", { name: /计算汇总/ })).toHaveTextContent("1,542.468");

    await userEvent.click(screen.getByRole("button", { name: "重新计算" }));
    await waitFor(() => expect(screen.getByRole("row", { name: /计算汇总/ })).toHaveTextContent("1,800.000"));
  });

  it("blocks duplicate recalculation requests while one is pending", async () => {
    api.getGridTrade.mockResolvedValue(detail);
    api.recalculateGridTrade.mockReturnValue(new Promise(() => undefined));
    render(<GridDetail id={detail.id} />);

    await screen.findByRole("heading", { name: "黄金 ETF" });
    const button = screen.getByRole("button", { name: "重新计算" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(api.recalculateGridTrade).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在计算…" })).toBeDisabled();
  });
});
