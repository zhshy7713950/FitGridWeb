// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientApiError } from "@/lib/api-client";

import type { ExportDownload } from "./types";
import { ExportDialog } from "./export-dialog";

const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

function pendingDownload(): Promise<ExportDownload> {
  return new Promise(() => undefined);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalCreateObjectUrl) {
    Object.defineProperty(URL, "createObjectURL", originalCreateObjectUrl);
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }
  if (originalRevokeObjectUrl) {
    Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectUrl);
  } else {
    Reflect.deleteProperty(URL, "revokeObjectURL");
  }
  document.body.style.removeProperty("overflow");
});

describe("ExportDialog downloads", () => {
  it("explains both formats and locks every action before a rapid repeat can dispatch", () => {
    const download = vi.fn(pendingDownload);
    render(<ExportDialog open onClose={vi.fn()} download={download} />);

    expect(screen.getByText(/重新导入安卓端或迁移到兼容应用/)).toBeInTheDocument();
    expect(screen.getByText(/服务器迁移和恢复，并保留稳定元数据/)).toBeInTheDocument();
    expect(screen.getByText(/两种备份都只包含当前账号的数据/)).toBeInTheDocument();

    const webDownload = screen.getByRole("button", { name: "下载 Web 完整备份" });
    act(() => {
      webDownload.click();
      webDownload.click();
    });

    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith("web");
    expect(screen.getByRole("button", { name: "正在准备备份…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下载 Android 兼容 JSON" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭数据备份" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("正在准备 Web 完整备份…");
  });

  it.each([
    ["android", "fitgridweb-android-2026-09-02.json", "下载 Android 兼容 JSON"],
    ["web", "fitgridweb-web-2026-09-02.json", "下载 Web 完整备份"],
  ] as const)("downloads %s with a temporary anchor and always removes its object URL", async (
    format,
    filename,
    buttonName,
  ) => {
    const createObjectURL = vi.fn(() => `blob:${format}-backup`);
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    let clickedDownload = "";
    let clickedHref = "";
    let connectedDuringClick = false;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function captureClick(
      this: HTMLAnchorElement,
    ) {
      clickedDownload = this.download;
      clickedHref = this.href;
      connectedDuringClick = this.isConnected;
    });
    const blob = new Blob(["{}"], { type: "application/json" });
    const download = vi.fn().mockResolvedValue({ blob, filename });

    render(<ExportDialog open onClose={vi.fn()} download={download} />);
    await userEvent.click(screen.getByRole("button", { name: buttonName }));

    await waitFor(() => expect(download).toHaveBeenCalledWith(format));
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickedDownload).toBe(filename);
    expect(clickedHref).toBe(`blob:${format}-backup`);
    expect(connectedDuringClick).toBe(true);
    expect(document.body.querySelector(`a[download="${filename}"]`)).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith(`blob:${format}-backup`);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("revokes the object URL and removes the anchor when its click fails", async () => {
    const createObjectURL = vi.fn(() => "blob:click-failure");
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    let connectedDuringClick = false;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function failClick(
      this: HTMLAnchorElement,
    ) {
      connectedDuringClick = this.isConnected;
      throw new Error("private browser failure");
    });
    const download = vi.fn().mockResolvedValue({
      blob: new Blob(["[]"]),
      filename: "fitgridweb-web-2026-09-02.json",
    });

    render(<ExportDialog open onClose={vi.fn()} download={download} />);
    await userEvent.click(screen.getByRole("button", { name: "下载 Web 完整备份" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("备份下载失败，请重试");
    expect(alert).not.toHaveTextContent("private browser failure");
    expect(connectedDuringClick).toBe(true);
    expect(document.body.querySelector("a[download]")).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:click-failure");
    expect(screen.getByRole("dialog", { name: "数据备份" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 Web 完整备份" })).toBeEnabled();
  });

  it("keeps the dialog retryable and avoids browser download work when the API fails", async () => {
    const createObjectURL = vi.fn();
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click");
    const download = vi.fn()
      .mockRejectedValueOnce(new ClientApiError(
        503,
        "EXPORT_UNAVAILABLE",
        "导出服务暂不可用",
        "req-export-7",
      ))
      .mockImplementationOnce(pendingDownload);

    render(<ExportDialog open onClose={vi.fn()} download={download} />);
    await userEvent.click(screen.getByRole("button", { name: "下载 Android 兼容 JSON" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("导出服务暂不可用");
    expect(alert).toHaveTextContent("请求 ID：req-export-7");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(anchorClick).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "数据备份" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "下载 Android 兼容 JSON" }));
    expect(download).toHaveBeenCalledTimes(2);
  });
});

describe("ExportDialog modal behavior", () => {
  function Harness({ download = vi.fn(pendingDownload) }: { download?: typeof pendingDownload }) {
    const [open, setOpen] = useState(false);
    return (
      <main>
        <button type="button" onClick={() => setOpen(true)}>打开数据备份</button>
        <ExportDialog open={open} onClose={() => setOpen(false)} download={download} />
      </main>
    );
  }

  it("traps and restores focus while isolating and restoring the full document", async () => {
    const user = userEvent.setup();
    document.body.style.overflow = "clip";
    render(
      <>
        <nav data-testid="outside-navigation" aria-hidden="false">导航</nav>
        <Harness />
        <footer data-testid="outside-footer" inert={true}>页脚</footer>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "打开数据备份" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "数据备份" });
    const close = within(dialog).getByRole("button", { name: "关闭数据备份" });
    const android = within(dialog).getByRole("button", { name: "下载 Android 兼容 JSON" });
    const web = within(dialog).getByRole("button", { name: "下载 Web 完整备份" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(close).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getByTestId("outside-navigation")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("outside-navigation")).toHaveAttribute("inert");
    expect(screen.getByTestId("outside-footer")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("outside-footer")).toHaveAttribute("inert");

    close.focus();
    await user.tab({ shift: true });
    expect(web).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    android.focus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "数据备份" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("clip");
    expect(screen.getByTestId("outside-navigation")).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByTestId("outside-navigation")).not.toHaveAttribute("inert");
    expect(screen.getByTestId("outside-footer")).not.toHaveAttribute("aria-hidden");
    expect(screen.getByTestId("outside-footer")).toHaveAttribute("inert");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("blocks close, Escape and backdrop dismissal while a download is pending", async () => {
    const download = vi.fn(pendingDownload);
    render(<Harness download={download} />);
    await userEvent.click(screen.getByRole("button", { name: "打开数据备份" }));
    await userEvent.click(screen.getByRole("button", { name: "下载 Web 完整备份" }));

    expect(screen.getByRole("dialog", { name: "数据备份" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭数据备份对话框" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "数据备份" })).toBeInTheDocument();
  });
});
