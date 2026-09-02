// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ImportPage from "@/app/(protected)/grids/import/page";

import type { GridImportController, GridImportState } from "./use-grid-import";
import { ImportWorkspace } from "./import-workspace";

function makeController(state: GridImportState): GridImportController {
  return {
    state,
    selectFile: vi.fn().mockResolvedValue(undefined),
    setPolicy: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  };
}

const previewState: Extract<GridImportState, { stage: "preview" }> = {
  stage: "preview",
  filename: "synthetic-backup.json",
  policy: "skip",
  error: null,
  preview: {
    previewToken: "synthetic-preview-token-longer-than-thirty-two-characters",
    expiresAt: "2099-01-01T00:15:00.000Z",
    creates: [
      {
        index: 0,
        productCode: "NEW-001",
        warnings: ["已补齐历史字段 category"],
      },
    ],
    conflicts: [{ index: 2, productCode: "EXISTING-003" }],
    invalid: [
      {
        index: 4,
        productCode: "BROKEN-005",
        fieldErrors: {
          maxPrice: ["最高价必须大于 0"],
          record: ["产品参数组合无效"],
        },
      },
    ],
    warnings: ["已忽略并重算 Android 派生字段", "已补齐历史字段 category"],
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  document.body.style.removeProperty("overflow");
});

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_APP_BASE_PATH;
});

describe("ImportWorkspace selection and preview", () => {
  it("explains the accepted formats, exact size limit, and server-owned data before selection", async () => {
    const user = userEvent.setup();
    const controller = makeController({ stage: "select", error: null });
    render(<ImportWorkspace controller={controller} />);

    expect(screen.getByRole("heading", { name: "导入网格数据" })).toBeInTheDocument();
    expect(screen.getByText(/Android 导出的 JSON 数组或 Web 完整备份/)).toBeInTheDocument();
    expect(screen.getByText(/文件上限 10 MiB/)).toBeInTheDocument();
    expect(screen.getByText(/账号归属、网格行与汇总值不会沿用/)).toBeInTheDocument();

    const input = screen.getByLabelText("选择 JSON 文件");
    expect(input).toHaveAttribute("accept", ".json,application/json");
    const file = new File(["[]"], "synthetic.json", { type: "application/json" });
    await user.upload(input, file);
    expect(controller.selectFile).toHaveBeenCalledWith(file);
  });

  it("renders four compact counts and expandable one-based safe record diagnostics", async () => {
    const user = userEvent.setup();
    const importedSecrets = {
      ...previewState,
      preview: {
        ...previewState.preview,
        ownerId: "private-owner-id",
        gridItems: [{ buyAmount: "private-derived-row" }],
        totalProfitAmount: "private-derived-total",
      },
    } as GridImportState;
    render(<ImportWorkspace controller={makeController(importedSecrets)} />);

    const summary = screen.getByRole("list", { name: "导入预检统计" });
    expect(within(summary).getByText("新增").parentElement).toHaveTextContent("1");
    expect(within(summary).getByText("冲突").parentElement).toHaveTextContent("1");
    expect(within(summary).getByText("无效").parentElement).toHaveTextContent("1");
    expect(within(summary).getByText("警告").parentElement).toHaveTextContent("2");

    await user.click(screen.getByText("新增记录"));
    await user.click(screen.getByText("冲突记录"));
    await user.click(screen.getByText("无效记录"));
    await user.click(screen.getByText("预检警告"));

    expect(screen.getByText("第 1 条")).toBeInTheDocument();
    expect(screen.getByText("第 3 条")).toBeInTheDocument();
    expect(screen.getByText("第 5 条")).toBeInTheDocument();
    expect(screen.getByText("NEW-001")).toBeInTheDocument();
    expect(screen.getByText("EXISTING-003")).toBeInTheDocument();
    expect(screen.getByText("BROKEN-005")).toBeInTheDocument();
    const fieldErrors = screen.getByRole("list", { name: "第 5 条字段错误" });
    expect(fieldErrors).toHaveTextContent("maxPrice：最高价必须大于 0");
    expect(fieldErrors).toHaveTextContent("record：产品参数组合无效");
    expect(screen.getAllByText("已忽略并重算 Android 派生字段")).toHaveLength(1);
    expect(screen.queryByText("private-owner-id")).not.toBeInTheDocument();
    expect(screen.queryByText("private-derived-row")).not.toBeInTheDocument();
    expect(screen.queryByText("private-derived-total")).not.toBeInTheDocument();
  });

  it("defaults to skip and commits it without a confirmation dialog", async () => {
    const user = userEvent.setup();
    const controller = makeController(previewState);
    render(<ImportWorkspace controller={controller} />);

    expect(screen.getByRole("radio", { name: /跳过冲突/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "开始导入" }));

    expect(controller.commit).toHaveBeenCalledWith("skip");
    expect(screen.queryByRole("dialog", { name: "确认覆盖现有产品" })).not.toBeInTheDocument();
  });

  it("requires a second confirmation for overwrite and prefixes the Web backup link", async () => {
    const user = userEvent.setup();
    vi.stubEnv("NEXT_PUBLIC_APP_BASE_PATH", "/fitgrid");
    const controller = makeController(previewState);
    controller.setPolicy = vi.fn((policy) => {
      controller.state = { ...previewState, policy };
    });
    const rendered = render(<ImportWorkspace controller={controller} />);

    await user.click(screen.getByRole("radio", { name: /覆盖冲突/ }));
    rendered.rerender(<ImportWorkspace controller={controller} />);
    expect(screen.getByRole("radio", { name: /覆盖冲突/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "开始导入" }));

    const dialog = screen.getByRole("dialog", { name: "确认覆盖现有产品" });
    expect(dialog).toHaveTextContent("此操作会替换当前账号中同代码产品");
    expect(within(dialog).getByRole("link", { name: "先下载 Web 完整备份" })).toHaveAttribute(
      "href",
      "/fitgrid/api/v1/grid-trades/export?format=web",
    );
    expect(controller.commit).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "确认覆盖并导入" }));
    expect(controller.commit).toHaveBeenCalledWith("overwrite");
  });

  it("shows public preview and commit errors with request IDs and a clear reselect action", async () => {
    const user = userEvent.setup();
    const expired = makeController({
      stage: "select",
      error: "导入预检已过期或已使用，请重新选择文件，请求 ID：req-preview-9",
    });
    const rendered = render(<ImportWorkspace controller={expired} />);

    const selectError = screen.getByRole("alert");
    expect(selectError).toHaveTextContent("导入预检已过期或已使用，请重新选择文件");
    expect(selectError).toHaveTextContent("req-preview-9");
    expect(selectError).not.toHaveTextContent("Error:");
    await user.click(screen.getByRole("button", { name: "重新选择文件" }));
    expect(expired.reset).toHaveBeenCalledTimes(1);

    const retryable = makeController({
      ...previewState,
      error: "导入服务暂不可用，请求 ID：req-commit-8",
    });
    rendered.rerender(<ImportWorkspace controller={retryable} />);
    expect(screen.getByRole("alert")).toHaveTextContent("req-commit-8");
    expect(screen.getByText("synthetic-backup.json")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /跳过冲突/ })).toBeChecked();
  });
});

describe("ImportWorkspace modal accessibility", () => {
  function overwriteController(): GridImportController {
    return makeController({ ...previewState, policy: "overwrite" });
  }

  it("traps focus, isolates the complete document, restores focus and supports idle dismissals", async () => {
    const user = userEvent.setup();
    document.body.style.overflow = "clip";
    const controller = overwriteController();
    render(
      <>
        <nav data-testid="outside-navigation" aria-hidden="false">外部导航</nav>
        <main><ImportWorkspace controller={controller} /></main>
        <footer data-testid="outside-footer" inert={true}>外部页脚</footer>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "开始导入" });
    await user.click(trigger);

    let dialog = screen.getByRole("dialog", { name: "确认覆盖现有产品" });
    const backup = within(dialog).getByRole("link", { name: "先下载 Web 完整备份" });
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    const confirm = within(dialog).getByRole("button", { name: "确认覆盖并导入" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(cancel).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getByTestId("outside-navigation")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("outside-navigation")).toHaveAttribute("inert");
    expect(screen.getByTestId("outside-footer")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("outside-footer")).toHaveAttribute("inert");

    backup.focus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(backup).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "确认覆盖现有产品" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("clip");
    expect(screen.getByTestId("outside-navigation")).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByTestId("outside-navigation")).not.toHaveAttribute("inert");
    expect(screen.getByTestId("outside-footer")).not.toHaveAttribute("aria-hidden");
    expect(screen.getByTestId("outside-footer")).toHaveAttribute("inert");
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    dialog = screen.getByRole("dialog", { name: "确认覆盖现有产品" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "确认覆盖现有产品" })).not.toBeInTheDocument();

    await user.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "关闭覆盖确认弹窗" }));
    expect(screen.queryByRole("dialog", { name: "确认覆盖现有产品" })).not.toBeInTheDocument();
  });

  it("keeps the dialog and outside document locked while overwrite commit is unresolved", async () => {
    const user = userEvent.setup();
    let resolveCommit!: () => void;
    const controller = overwriteController();
    controller.commit = vi.fn(() => new Promise<void>((resolve) => {
      resolveCommit = resolve;
    }));
    render(
      <>
        <nav data-testid="locked-navigation" aria-label="外部主导航">外部导航</nav>
        <ImportWorkspace controller={controller} />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "开始导入" }));
    const dialog = screen.getByRole("dialog", { name: "确认覆盖现有产品" });
    await user.click(within(dialog).getByRole("button", { name: "确认覆盖并导入" }));

    expect(within(dialog).getByRole("button", { name: "正在覆盖导入…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByTestId("locked-navigation")).toHaveAttribute("inert");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "确认覆盖现有产品" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭覆盖确认弹窗" }));
    expect(screen.getByRole("dialog", { name: "确认覆盖现有产品" })).toBeInTheDocument();

    resolveCommit();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "确认覆盖现有产品" })).not.toBeInTheDocument();
    });
  });
});

describe("ImportWorkspace busy and complete states", () => {
  it.each([
    [
      { stage: "previewing", filename: "previewing.json" } as GridImportState,
      "正在预检文件…",
      "previewing.json",
    ],
    [
      {
        stage: "committing",
        filename: previewState.filename,
        preview: previewState.preview,
        policy: "skip",
      } as GridImportState,
      "正在导入数据…",
      "synthetic-backup.json",
    ],
  ])("keeps useful %s context under a centered accessible busy overlay", (state, status, context) => {
    render(<ImportWorkspace controller={makeController(state)} />);

    expect(screen.getByRole("status")).toHaveTextContent(status);
    expect(screen.getByText(context)).toBeInTheDocument();
    expect(screen.getByLabelText("导入工作区")).toHaveAttribute("aria-busy", "true");
  });

  it("renders every completion count and returns to the product list", () => {
    const controller = makeController({
      stage: "complete",
      report: { created: 7, overwritten: 3, skipped: 2, invalid: 1 },
    });
    render(<ImportWorkspace controller={controller} />);

    const report = screen.getByRole("list", { name: "导入结果统计" });
    expect(within(report).getByText("已新增").parentElement).toHaveTextContent("7");
    expect(within(report).getByText("已覆盖").parentElement).toHaveTextContent("3");
    expect(within(report).getByText("已跳过").parentElement).toHaveTextContent("2");
    expect(within(report).getByText("无效").parentElement).toHaveTextContent("1");
    expect(screen.getByRole("link", { name: "返回产品列表" })).toHaveAttribute("href", "/grids");
  });
});

describe("protected import route", () => {
  it("renders the controller-backed import workspace inside the protected route tree", () => {
    render(<ImportPage />);

    expect(screen.getByRole("heading", { name: "导入网格数据" })).toBeInTheDocument();
    expect(screen.getByLabelText("选择 JSON 文件")).toBeInTheDocument();
  });
});
