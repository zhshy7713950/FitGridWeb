// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientApiError } from "@/lib/api-client";

import {
  DataVault,
  downloadMaintenanceArchive,
  type MaintenanceApi,
} from "./data-vault";
import type { MaintenanceJobStatus, PortableBackupSummary } from "./types";

const JOB_ID = "00000000-0000-4000-8000-000000000031";
const RESTORE_ID = "00000000-0000-4000-8000-000000000032";

function queued(type: "backup" | "inspect-restore" | "restore", id = JOB_ID) {
  return { id, type, state: "queued" as const, requestId: "01QUEUED" };
}

function status(
  state: MaintenanceJobStatus["state"],
  type: MaintenanceJobStatus["type"] = "backup",
  id = JOB_ID,
): MaintenanceJobStatus {
  return {
    id,
    type,
    state,
    requestId: "01JOB",
    updatedAt: "2026-09-03T07:00:00.000Z",
  };
}

function api(overrides: Partial<MaintenanceApi> = {}): MaintenanceApi {
  return {
    listBackups: vi.fn().mockResolvedValue({ items: [] }),
    createBackup: vi.fn().mockResolvedValue(queued("backup")),
    getJob: vi.fn().mockResolvedValue(status("ready")),
    issueDownload: vi.fn().mockResolvedValue("/api/v1/admin/backups/backup/download?token=x"),
    uploadRestore: vi.fn().mockResolvedValue(queued("inspect-restore", RESTORE_ID)),
    confirmRestore: vi.fn().mockResolvedValue(queued("restore", RESTORE_ID)),
    checkHealth: vi.fn().mockResolvedValue(true),
    download: vi.fn(),
    replaceLocation: vi.fn(),
    clearClientSession: vi.fn(),
    ...overrides,
  };
}

function archiveFile() {
  return new File([new Uint8Array(4096)], "fitgridweb-20260903T070000Z.fitgridbackup", {
    type: "application/vnd.fitgrid.backup",
  });
}

async function fillBackupDialog() {
  fireEvent.change(screen.getByLabelText("当前管理员密码"), {
    target: { value: "current-password" },
  });
  fireEvent.change(screen.getByLabelText("独立备份密码"), {
    target: { value: "portable-password" },
  });
  fireEvent.change(screen.getByLabelText("再次确认备份密码"), {
    target: { value: "portable-password" },
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.body.style.overflow = "";
});

describe("data vault backup custody", () => {
  it("locks duplicate submissions, clears secrets, and shows the three requested stages", async () => {
    vi.useFakeTimers();
    const createBackup = vi.fn().mockResolvedValue(queued("backup"));
    const getJob = vi.fn()
      .mockResolvedValueOnce(status("dumping"))
      .mockResolvedValueOnce(status("encrypting"))
      .mockResolvedValueOnce(status("ready"));
    render(<DataVault api={api({ createBackup, getJob })} initialBackups={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "创建备份" }));
    await fillBackupDialog();
    const form = screen.getByRole("button", { name: "确认创建" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await act(async () => {});

    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "创建便携备份" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在创建备份…" })).toBeDisabled();
    expect(screen.getByText("正在生成")).toHaveAttribute("aria-current", "step");
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByText("正在加密")).toHaveAttribute("aria-current", "step");
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByText("可以下载")).toHaveAttribute("aria-current", "step");

    fireEvent.click(screen.getByRole("button", { name: "创建备份" }));
    expect(screen.getByLabelText("当前管理员密码")).toHaveValue("");
    expect(screen.getByLabelText("独立备份密码")).toHaveValue("");
    expect(screen.getByLabelText("再次确认备份密码")).toHaveValue("");
  });

  it("locks restore upload while a backup maintenance job is active", async () => {
    const createBackup = vi.fn().mockResolvedValue(queued("backup"));
    const getJob = vi.fn().mockResolvedValue(status("dumping"));
    render(<DataVault api={api({ createBackup, getJob })} initialBackups={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "创建备份" }));
    await fillBackupDialog();
    fireEvent.submit(screen.getByRole("button", { name: "确认创建" }).closest("form")!);
    await act(async () => {});

    expect(screen.getByLabelText("选择便携备份文件")).toBeDisabled();
    expect(screen.getByLabelText("备份密码")).toBeDisabled();
    expect(screen.getByRole("button", { name: "上传并检查" })).toBeDisabled();
  });

  it("validates 12–128 characters and matching backup passwords before the API call", async () => {
    const createBackup = vi.fn();
    render(<DataVault api={api({ createBackup })} initialBackups={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "创建备份" }));
    await userEvent.type(screen.getByLabelText("当前管理员密码"), "current-password");
    await userEvent.type(screen.getByLabelText("独立备份密码"), "short");
    await userEvent.type(screen.getByLabelText("再次确认备份密码"), "different-password");
    await userEvent.click(screen.getByRole("button", { name: "确认创建" }));

    expect(screen.getByText("备份密码必须包含 12–128 个字符")).toBeInTheDocument();
    expect(screen.getByText("两次输入的备份密码不一致")).toBeInTheDocument();
    expect(createBackup).not.toHaveBeenCalled();
  });

  it("shows at most five successful backups in newest-first local time and IEC size", () => {
    const backups: PortableBackupSummary[] = Array.from({ length: 6 }, (_, index) => ({
      id: `backup-${index}`,
      createdAt: `2026-09-0${index + 1}T07:00:00.000Z`,
      size: index === 5 ? 13_002_342 : 1024 * (index + 1),
      sha256: String(index).repeat(64),
    }));
    render(<DataVault api={api()} initialBackups={backups} />);

    const history = screen.getByRole("list", { name: "历史备份" });
    expect(within(history).getAllByRole("listitem")).toHaveLength(5);
    expect(within(history).getAllByRole("button", { name: /下载备份/ })).toHaveLength(5);
    expect(within(history).getAllByRole("listitem")[0]).toHaveTextContent("2026-09-06 15:00");
    expect(within(history).getAllByRole("listitem")[0]).toHaveTextContent("12.4 MiB");
    expect(within(history).queryByText("2026-09-01 15:00")).not.toBeInTheDocument();
  });

  it("requests a token then downloads without buffering or using login navigation", async () => {
    const issueDownload = vi.fn().mockResolvedValue("/fitgrid/api/v1/admin/backups/a/download?token=t");
    const download = vi.fn();
    const replaceLocation = vi.fn();
    render(<DataVault api={api({ issueDownload, download, replaceLocation })} initialBackups={[{
      id: "backup-a",
      createdAt: "2026-09-03T07:00:00.000Z",
      size: 1024,
      sha256: "a".repeat(64),
    }]} />);

    await userEvent.click(screen.getByRole("button", { name: "下载备份 2026-09-03 15:00" }));
    expect(issueDownload).toHaveBeenCalledWith("backup-a", expect.any(AbortSignal));
    expect(download).toHaveBeenCalledWith(
      "/fitgrid/api/v1/admin/backups/a/download?token=t",
      "fitgridweb-20260903T070000Z.fitgridbackup",
    );
    expect(replaceLocation).not.toHaveBeenCalled();
  });

  it("creates, clicks, and removes a safe browser download anchor", () => {
    let clickedAnchor: {
      connected: boolean;
      download: string;
      href: string | null;
      rel: string;
    } | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(
      this: HTMLAnchorElement,
    ) {
      clickedAnchor = {
        connected: this.isConnected,
        download: this.download,
        href: this.getAttribute("href"),
        rel: this.rel,
      };
    });

    downloadMaintenanceArchive(
      "data:application/vnd.fitgrid.backup;base64,Rml0R3JpZA==",
      "fitgridweb-20260903T070000Z.fitgridbackup",
    );

    expect(clickedAnchor).not.toBeNull();
    expect(clickedAnchor!.href).toBe(
      "data:application/vnd.fitgrid.backup;base64,Rml0R3JpZA==",
    );
    expect(clickedAnchor!.download).toBe("fitgridweb-20260903T070000Z.fitgridbackup");
    expect(clickedAnchor!.rel).toBe("noopener noreferrer");
    expect(clickedAnchor!.connected).toBe(true);
    expect(document.querySelector('a[download="fitgridweb-20260903T070000Z.fitgridbackup"]'))
      .toBeNull();
  });

  it("traps focus, isolates the page, closes on Escape, and clears all backup secrets", async () => {
    render(<main data-testid="outside"><DataVault api={api()} initialBackups={[]} /></main>);
    const trigger = screen.getByRole("button", { name: "创建备份" });
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "创建便携备份" });
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("当前管理员密码")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByLabelText("独立备份密码")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("再次确认备份密码")).toHaveAttribute("autocomplete", "new-password");
    expect(cancel).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    await fillBackupDialog();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "创建便携备份" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    expect(screen.getByLabelText("当前管理员密码")).toHaveValue("");
    expect(screen.getByLabelText("独立备份密码")).toHaveValue("");
    expect(screen.getByLabelText("再次确认备份密码")).toHaveValue("");
  });

  it("shows public API errors with request IDs but never exposes secret fields", async () => {
    const createBackup = vi.fn().mockRejectedValue(new ClientApiError(
      422,
      "VALIDATION_FAILED",
      "备份密码不符合要求",
      "01PUBLIC",
    ));
    render(<DataVault api={api({ createBackup })} initialBackups={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "创建备份" }));
    await fillBackupDialog();
    await userEvent.click(screen.getByRole("button", { name: "确认创建" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("备份密码不符合要求");
    expect(alert).toHaveTextContent("请求 ID：01PUBLIC");
    expect(alert).not.toHaveTextContent("portable-password");
  });

  it("shows terminal maintenance failure codes with the originating request ID", async () => {
    const failedJob = {
      ...status("failed"),
      code: "BACKUP_ENCRYPT_FAILED",
      requestId: "01HOSTFAIL",
    };
    render(<DataVault api={api({ getJob: vi.fn().mockResolvedValue(failedJob) })} initialBackups={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "创建备份" }));
    await fillBackupDialog();
    fireEvent.submit(screen.getByRole("button", { name: "确认创建" }).closest("form")!);
    await act(async () => {});

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("维护任务失败：BACKUP_ENCRYPT_FAILED");
    expect(alert).toHaveTextContent("请求 ID：01HOSTFAIL");
  });
});

describe("data vault destructive recovery", () => {
  it("uploads the selected stream, shows immutable preview, and gates restore confirmation", async () => {
    vi.useFakeTimers();
    const file = archiveFile();
    const uploadRestore = vi.fn().mockResolvedValue(queued("inspect-restore", RESTORE_ID));
    const preview: MaintenanceJobStatus = {
      ...status("awaiting-confirmation", "inspect-restore", RESTORE_ID),
      backupCreatedAt: "2026-09-03T06:30:00.000Z",
      postgresMajor: 17,
      database: "fitgridweb",
      expiresAt: 1_788_418_200,
      preview: { users: 2, gridTrades: 24, invitations: 1, importPreviews: 0 },
    };
    const getJob = vi.fn().mockResolvedValue(preview);
    render(<DataVault api={api({ uploadRestore, getJob })} initialBackups={[]} />);

    fireEvent.change(screen.getByLabelText("选择便携备份文件"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("备份密码"), { target: { value: "portable-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "上传并检查" }).closest("form")!);
    await act(async () => {});

    expect(uploadRestore).toHaveBeenCalledWith(file, "portable-password", expect.any(AbortSignal));
    expect(screen.getByLabelText("备份密码")).toHaveValue("");
    expect(screen.getByText("24 个网格产品")).toBeInTheDocument();
    expect(screen.getByText("2 个用户")).toBeInTheDocument();
    expect(screen.getByText("完整性检查通过")).toBeInTheDocument();
    const verifiedPreview = screen.getByRole("region", { name: "恢复预检已通过" });
    expect(within(verifiedPreview).queryByText("4.0 KiB")).not.toBeInTheDocument();
    expect(within(verifiedPreview).queryByText(/应用镜像/)).not.toBeInTheDocument();
    const restore = screen.getByRole("button", { name: "恢复全部数据" });
    expect(restore).toBeEnabled();
    fireEvent.click(restore);
    expect(screen.getByRole("button", { name: "确认替换全部数据" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "current-password" } });
    fireEvent.change(screen.getByLabelText("输入“恢复全部数据”以确认"), {
      target: { value: "恢复全部数据" },
    });
    expect(screen.getByRole("button", { name: "确认替换全部数据" })).toBeEnabled();
  });

  it("locks the destructive dialog after acceptance and shows expected downtime", async () => {
    vi.useFakeTimers();
    const preview = {
      ...status("awaiting-confirmation", "inspect-restore", RESTORE_ID),
      backupCreatedAt: "2026-09-03T06:30:00.000Z",
      postgresMajor: 17,
      database: "fitgridweb",
      expiresAt: 1_788_418_200,
      preview: { users: 2, gridTrades: 24, invitations: 1, importPreviews: 0 },
    };
    const confirmRestore = vi.fn().mockResolvedValue(queued("restore", RESTORE_ID));
    const getJob = vi.fn()
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ ...status("restoring", "restore", RESTORE_ID) });
    render(<DataVault api={api({ confirmRestore, getJob })} initialBackups={[]} />);
    fireEvent.change(screen.getByLabelText("选择便携备份文件"), {
      target: { files: [archiveFile()] },
    });
    fireEvent.change(screen.getByLabelText("备份密码"), { target: { value: "portable-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "上传并检查" }).closest("form")!);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "恢复全部数据" }));
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "current-password" } });
    fireEvent.change(screen.getByLabelText("输入“恢复全部数据”以确认"), {
      target: { value: "恢复全部数据" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "确认替换全部数据" }).closest("form")!);
    fireEvent.click(screen.getByRole("button", { name: "关闭恢复确认对话框" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(confirmRestore).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "确认整库恢复" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭恢复确认" })).toBeDisabled();
    await act(async () => {});
    expect(screen.getAllByText("服务器正在恢复数据，请勿关闭页面")).not.toHaveLength(0);
  });

  it("clears client session and navigates to the base-path login after restore success", async () => {
    vi.useFakeTimers();
    const clearClientSession = vi.fn();
    const replaceLocation = vi.fn();
    const preview = {
      ...status("awaiting-confirmation", "inspect-restore", RESTORE_ID),
      backupCreatedAt: "2026-09-03T06:30:00.000Z",
      postgresMajor: 17,
      database: "fitgridweb",
      expiresAt: 1_788_418_200,
      preview: { users: 2, gridTrades: 24, invitations: 1, importPreviews: 0 },
    };
    const getJob = vi.fn()
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ ...status("succeeded", "restore", RESTORE_ID) });
    render(<DataVault api={api({ getJob, clearClientSession, replaceLocation })} initialBackups={[]} />);
    fireEvent.change(screen.getByLabelText("选择便携备份文件"), {
      target: { files: [archiveFile()] },
    });
    fireEvent.change(screen.getByLabelText("备份密码"), { target: { value: "portable-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "上传并检查" }).closest("form")!);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "恢复全部数据" }));
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "current-password" } });
    fireEvent.change(screen.getByLabelText("输入“恢复全部数据”以确认"), {
      target: { value: "恢复全部数据" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "确认替换全部数据" }).closest("form")!);
    await act(async () => {});

    expect(clearClientSession).toHaveBeenCalledTimes(1);
    expect(replaceLocation).toHaveBeenCalledWith("/login");
  });

  it("checks health through expected downtime and resumes the final restore status", async () => {
    vi.useFakeTimers();
    const clearClientSession = vi.fn();
    const replaceLocation = vi.fn();
    const checkHealth = vi.fn().mockResolvedValue(true);
    const preview = {
      ...status("awaiting-confirmation", "inspect-restore", RESTORE_ID),
      backupCreatedAt: "2026-09-03T06:30:00.000Z",
      postgresMajor: 17,
      database: "fitgridweb",
      expiresAt: 1_788_418_200,
      preview: { users: 2, gridTrades: 24, invitations: 1, importPreviews: 0 },
    };
    const getJob = vi.fn()
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ ...status("restoring", "restore", RESTORE_ID) })
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce({ ...status("succeeded", "restore", RESTORE_ID) });
    render(<DataVault api={api({
      getJob,
      checkHealth,
      clearClientSession,
      replaceLocation,
    })} initialBackups={[]} />);
    fireEvent.change(screen.getByLabelText("选择便携备份文件"), {
      target: { files: [archiveFile()] },
    });
    fireEvent.change(screen.getByLabelText("备份密码"), { target: { value: "portable-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "上传并检查" }).closest("form")!);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "恢复全部数据" }));
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "current-password" } });
    fireEvent.change(screen.getByLabelText("输入“恢复全部数据”以确认"), {
      target: { value: "恢复全部数据" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "确认替换全部数据" }).closest("form")!);
    await act(async () => {});

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(checkHealth).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(screen.getByText("服务已恢复，正在读取最终结果…")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(clearClientSession).toHaveBeenCalledTimes(1);
    expect(replaceLocation).toHaveBeenCalledWith("/login");
  });

  it.each([
    ["failed", "RESTORE_FAILED", "维护任务失败：RESTORE_FAILED", false],
    ["intervention-required", "ROLLBACK_FAILED", "维护任务需要人工处理：ROLLBACK_FAILED", true],
  ] as const)(
    "shows an accessible %s result inside the restore dialog and allows it to close",
    async (terminalState, code, message, intervention) => {
      vi.useFakeTimers();
      const preview = {
        ...status("awaiting-confirmation", "inspect-restore", RESTORE_ID),
        backupCreatedAt: "2026-09-03T06:30:00.000Z",
        postgresMajor: 17,
        database: "fitgridweb",
        expiresAt: 1_788_418_200,
        preview: { users: 2, gridTrades: 24, invitations: 1, importPreviews: 0 },
      };
      const getJob = vi.fn()
        .mockResolvedValueOnce(preview)
        .mockResolvedValueOnce({
          ...status(terminalState, "restore", RESTORE_ID),
          code,
          rolledBack: terminalState === "failed",
        });
      render(<DataVault api={api({ getJob })} initialBackups={[]} />);
      fireEvent.change(screen.getByLabelText("选择便携备份文件"), {
        target: { files: [archiveFile()] },
      });
      fireEvent.change(screen.getByLabelText("备份密码"), { target: { value: "portable-password" } });
      fireEvent.submit(screen.getByRole("button", { name: "上传并检查" }).closest("form")!);
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "恢复全部数据" }));
      fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "current-password" } });
      fireEvent.change(screen.getByLabelText("输入“恢复全部数据”以确认"), {
        target: { value: "恢复全部数据" },
      });
      fireEvent.submit(screen.getByRole("button", { name: "确认替换全部数据" }).closest("form")!);
      await act(async () => {});

      const dialog = screen.getByRole("dialog", { name: "确认整库恢复" });
      expect(within(dialog).getByRole("alert")).toHaveTextContent(message);
      expect(within(dialog).getByRole("button", { name: "关闭恢复确认" })).toBeEnabled();
      if (intervention) {
        expect(dialog).toHaveTextContent("journalctl -u fitgridweb-maintenance.service");
        expect(dialog).toHaveTextContent("运维手册");
      }
      fireEvent.click(within(dialog).getByRole("button", { name: "关闭恢复确认" }));
      expect(screen.queryByRole("dialog", { name: "确认整库恢复" })).not.toBeInTheDocument();
    },
  );

  it("does not reuse a prior healthy probe during a later disconnect", async () => {
    vi.useFakeTimers();
    const secondHealth = deferred<boolean>();
    const checkHealth = vi.fn()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => secondHealth.promise);
    const preview = {
      ...status("awaiting-confirmation", "inspect-restore", RESTORE_ID),
      backupCreatedAt: "2026-09-03T06:30:00.000Z",
      postgresMajor: 17,
      database: "fitgridweb",
      expiresAt: 1_788_418_200,
      preview: { users: 2, gridTrades: 24, invitations: 1, importPreviews: 0 },
    };
    const restoring = { ...status("restoring", "restore", RESTORE_ID) };
    const getJob = vi.fn()
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(restoring)
      .mockRejectedValueOnce(new TypeError("first disconnect"))
      .mockResolvedValueOnce(restoring)
      .mockRejectedValueOnce(new TypeError("second disconnect"));
    render(<DataVault api={api({ getJob, checkHealth })} initialBackups={[]} />);
    fireEvent.change(screen.getByLabelText("选择便携备份文件"), {
      target: { files: [archiveFile()] },
    });
    fireEvent.change(screen.getByLabelText("备份密码"), { target: { value: "portable-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "上传并检查" }).closest("form")!);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "恢复全部数据" }));
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "current-password" } });
    fireEvent.change(screen.getByLabelText("输入“恢复全部数据”以确认"), {
      target: { value: "恢复全部数据" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "确认替换全部数据" }).closest("form")!);
    await act(async () => {});

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByText("服务已恢复，正在读取最终结果…")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.queryByText("服务已恢复，正在读取最终结果…")).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(checkHealth).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("服务已恢复，正在读取最终结果…")).not.toBeInTheDocument();
    expect(screen.getByText("服务短暂离线，正在检查健康状态…")).toBeInTheDocument();

    await act(async () => secondHealth.resolve(true));
    expect(screen.getByText("服务已恢复，正在读取最终结果…")).toBeInTheDocument();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
