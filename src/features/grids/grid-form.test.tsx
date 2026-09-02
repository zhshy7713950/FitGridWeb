// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientApiError } from "@/lib/api-client";

import {
  defaultGridFormValues,
  type GridFormValues,
} from "./grid-form-model";
import type { GridTradeDetail } from "./types";

const api = vi.hoisted(() => ({
  createGridTrade: vi.fn(),
  getGridTrade: vi.fn(),
  updateGridTrade: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));
vi.mock("./grid-api", () => api);

import { GridForm } from "./grid-form";
import { EditGridFormPage, NewGridFormPage } from "./grid-form-page";

const validFormValues: GridFormValues = {
  ...defaultGridFormValues,
  productName: "黄金 ETF",
  productCode: "518880",
  maxPrice: "6.92",
  category: "ETF",
};

const detail: GridTradeDetail = {
  id: "grid-1",
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
    items: [],
    totalBuyAmount: "0",
    totalProfitAmount: "0",
    totalProfitRate: "0",
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  api.createGridTrade.mockReset();
  api.getGridTrade.mockReset();
  api.updateGridTrade.mockReset();
  navigation.push.mockReset();
});

describe("GridForm", () => {
  it("renders three semantic parameter groups without exposing the algorithm version", () => {
    render(
      <GridForm
        initialValues={defaultGridFormValues}
        submitLabel="创建产品"
        onSubmit={vi.fn()}
      />,
    );

    for (const name of ["产品标识", "价格阶梯", "仓位规则"]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument();
    }
    expect(screen.queryByText(/android-v2\.1\.0/i)).not.toBeInTheDocument();
  });

  it("hides long-only controls when direction changes to short", async () => {
    render(
      <GridForm
        initialValues={defaultGridFormValues}
        submitLabel="创建产品"
        onSubmit={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "做空" }));

    expect(screen.getByRole("button", { name: "做空" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText("留存份数")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("中网幅度")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("大网幅度")).not.toBeInTheDocument();
  });

  it("clears long-only controlled values before returning to long", async () => {
    render(
      <GridForm
        initialValues={validFormValues}
        submitLabel="保存修改"
        onSubmit={vi.fn()}
      />,
    );
    const keepShare = screen.getByLabelText("留存份数");
    const mediumAmplitude = screen.getByLabelText("中网幅度");
    const bigAmplitude = screen.getByLabelText("大网幅度");
    await userEvent.clear(keepShare);
    await userEvent.type(keepShare, "9");
    await userEvent.clear(mediumAmplitude);
    await userEvent.type(mediumAmplitude, "25");
    await userEvent.clear(bigAmplitude);
    await userEvent.type(bigAmplitude, "40");

    await userEvent.click(screen.getByRole("button", { name: "做空" }));
    await userEvent.click(screen.getByRole("button", { name: "做多" }));

    expect(screen.getByLabelText("留存份数")).toHaveValue("");
    expect(screen.getByLabelText("中网幅度")).toHaveValue("");
    expect(screen.getByLabelText("大网幅度")).toHaveValue("");
  });

  it("validates fields inline and submits the normalized mutation input", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <GridForm
        initialValues={defaultGridFormValues}
        submitLabel="创建产品"
        onSubmit={onSubmit}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "创建产品" }));
    const productCode = screen.getByLabelText("产品代码");
    expect(screen.getByText("产品代码不能为空")).toHaveAttribute("role", "alert");
    expect(productCode).toHaveAttribute("aria-invalid", "true");

    await userEvent.type(productCode, " 518880 ");
    await userEvent.click(screen.getByRole("button", { name: "创建产品" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      productCode: "518880",
      maxPrice: "1",
      keepShare: 2,
      mediumAmplitude: 15,
      isShort: false,
    }));
  });

  it("associates injected server field errors with their controls", () => {
    render(
      <GridForm
        initialValues={validFormValues}
        submitLabel="保存修改"
        onSubmit={vi.fn()}
        serverFieldErrors={{ productCode: ["产品代码已存在"] }}
        formError="保存失败，请检查参数"
      />,
    );

    const input = screen.getByLabelText("产品代码");
    expect(screen.getByText("产品代码已存在")).toHaveAttribute("role", "alert");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toContain("productCode-error");
    expect(screen.getByRole("alert", { name: "表单错误" })).toHaveTextContent("保存失败，请检查参数");
  });

  it("blocks a second save while the first save is pending", async () => {
    const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
    render(
      <GridForm
        initialValues={validFormValues}
        submitLabel="创建产品"
        onSubmit={onSubmit}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "创建产品" }));
    const pending = screen.getByRole("button", { name: "正在保存…" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("keeps the save lock after success until route unmount", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <GridForm
        initialValues={validFormValues}
        submitLabel="创建产品"
        onSubmit={onSubmit}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "创建产品" }));
    const locked = await screen.findByRole("button", { name: "正在保存…" });
    expect(locked).toBeDisabled();
    fireEvent.click(locked);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("guards only dirty browser and cancel navigation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <GridForm
        initialValues={validFormValues}
        submitLabel="保存修改"
        onSubmit={vi.fn()}
      />,
    );

    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);

    await userEvent.type(screen.getByLabelText("产品名称"), " A");
    const dirtyUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);

    const cancel = screen.getByRole("link", { name: "取消" });
    fireEvent.click(cancel);
    expect(confirm).toHaveBeenCalledWith("尚有未保存的修改，确定离开吗？");
  });
});

describe("grid form page controllers", () => {
  it("creates a product and routes to its detail", async () => {
    api.createGridTrade.mockResolvedValue(detail);
    render(<NewGridFormPage />);

    await userEvent.type(screen.getByLabelText("产品代码"), "518880");
    await userEvent.click(screen.getByRole("button", { name: "创建产品" }));

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/grids/grid-1"));
  });

  it("maps create field errors back to the reusable form", async () => {
    api.createGridTrade.mockRejectedValue(new ClientApiError(
      422,
      "VALIDATION_ERROR",
      "请求参数校验失败",
      "req-1",
      { productCode: ["产品代码已存在"] },
    ));
    render(<NewGridFormPage />);

    await userEvent.type(screen.getByLabelText("产品代码"), "518880");
    await userEvent.click(screen.getByRole("button", { name: "创建产品" }));

    expect(await screen.findByText("产品代码已存在")).toHaveAttribute("role", "alert");
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("unlocks after a failed create so the user can retry", async () => {
    api.createGridTrade
      .mockRejectedValueOnce(new ClientApiError(
        422,
        "VALIDATION_ERROR",
        "请求参数校验失败",
        "req-1",
        { productCode: ["产品代码已存在"] },
      ))
      .mockResolvedValueOnce(detail);
    render(<NewGridFormPage />);
    await userEvent.type(screen.getByLabelText("产品代码"), "518880");

    await userEvent.click(screen.getByRole("button", { name: "创建产品" }));
    await screen.findByText("产品代码已存在");
    const retry = screen.getByRole("button", { name: "创建产品" });
    expect(retry).toBeEnabled();
    await userEvent.click(retry);

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/grids/grid-1"));
    expect(api.createGridTrade).toHaveBeenCalledTimes(2);
  });

  it("focuses product code when the server reports a code conflict", async () => {
    api.createGridTrade.mockRejectedValue(new ClientApiError(
      409,
      "PRODUCT_CODE_CONFLICT",
      "产品代码已存在",
      "req-conflict",
      { productCode: ["产品代码已存在"] },
    ));
    render(<NewGridFormPage />);
    const productCode = screen.getByLabelText("产品代码");
    await userEvent.type(productCode, "518880");

    await userEvent.click(screen.getByRole("button", { name: "创建产品" }));
    await screen.findByText("产品代码已存在");

    expect(productCode).toHaveFocus();
  });

  it("loads an existing product and sends its optimistic-lock timestamp", async () => {
    api.getGridTrade.mockResolvedValue(detail);
    api.updateGridTrade.mockResolvedValue(detail);
    render(<EditGridFormPage id="grid-1" />);

    expect(screen.getByRole("status")).toHaveTextContent("正在加载产品…");
    expect(await screen.findByLabelText("产品代码")).toHaveValue("518880");
    await userEvent.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(api.updateGridTrade).toHaveBeenCalledWith(
      "grid-1",
      expect.objectContaining({ expectedUpdatedAt: detail.updatedAt, productCode: "518880" }),
    ));
    expect(navigation.push).toHaveBeenCalledWith("/grids/grid-1");
  });

  it("translates edit conflicts and allows the user to reload", async () => {
    api.getGridTrade.mockResolvedValue(detail);
    api.updateGridTrade.mockRejectedValue(new ClientApiError(
      409,
      "EDIT_CONFLICT",
      "conflict",
    ));
    render(<EditGridFormPage id="grid-1" />);

    await screen.findByLabelText("产品代码");
    await userEvent.click(screen.getByRole("button", { name: "保存修改" }));

    expect(await screen.findByRole("alert", { name: "表单错误" })).toHaveTextContent(
      "产品已在其他页面更新，请重新载入后再编辑",
    );
  });

  it("shows a recoverable loading error", async () => {
    api.getGridTrade
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(detail);
    render(<EditGridFormPage id="grid-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("加载产品失败，请重试");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByLabelText("产品代码")).toHaveValue("518880");
    expect(api.getGridTrade).toHaveBeenCalledTimes(2);
  });

  it("shows a non-retryable missing-resource state for an edit 404", async () => {
    api.getGridTrade.mockRejectedValue(new ClientApiError(
      404,
      "GRID_TRADE_NOT_FOUND",
      "网格产品不存在",
      "req-not-found",
    ));
    render(<EditGridFormPage id="missing-grid" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("网格产品不存在");
    expect(alert).toHaveTextContent("请求 ID：req-not-found");
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  });

  it("shows a public load error request id without exposing its stack", async () => {
    const error = new ClientApiError(
      503,
      "SERVICE_UNAVAILABLE",
      "服务暂时不可用",
      "req-public",
    );
    error.stack = "SECRET_INTERNAL_STACK";
    api.getGridTrade.mockRejectedValue(error);
    render(<EditGridFormPage id="grid-1" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("服务暂时不可用");
    expect(alert).toHaveTextContent("请求 ID：req-public");
    expect(alert).not.toHaveTextContent("SECRET_INTERNAL_STACK");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
