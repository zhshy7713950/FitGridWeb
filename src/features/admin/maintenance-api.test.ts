// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  confirmRestore,
  createPortableBackup,
  getMaintenanceJob,
  issueBackupDownload,
  listPortableBackups,
  uploadRestoreForInspection,
} from "./maintenance-api";

const JOB_ID = "00000000-0000-4000-8000-000000000031";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("administrator maintenance client", () => {
  it("sends backup secrets once without writing browser storage", async () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      id: JOB_ID,
      type: "backup",
      state: "queued",
      requestId: "01BACKUP",
    }, { status: 202 }));
    vi.stubGlobal("fetch", fetcher);

    await createPortableBackup({
      currentPassword: "current-password",
      backupPassword: "portable-password",
      confirmBackupPassword: "portable-password",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/admin/backups",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          currentPassword: "current-password",
          backupPassword: "portable-password",
          confirmBackupPassword: "portable-password",
        }),
      }),
    );
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it("streams the raw archive body with its name, size, and passphrase headers", async () => {
    const stream = new ReadableStream<Uint8Array>();
    const file = {
      name: "fitgridweb-20260903T070000Z.fitgridbackup",
      size: 8192,
      stream: vi.fn(() => stream),
    } as unknown as File;
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      id: JOB_ID,
      type: "inspect-restore",
      state: "queued",
      requestId: "01UPLOAD",
    }, { status: 202 }));
    vi.stubGlobal("fetch", fetcher);

    await uploadRestoreForInspection(file, "portable-password");

    expect(file.stream).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(
      "/api/v1/admin/restores/uploads?fileName=fitgridweb-20260903T070000Z.fitgridbackup",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe(stream);
    expect((init as RequestInit & { duplex?: string }).duplex).toBe("half");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/vnd.fitgrid.backup");
    expect(headers.get("X-FitGrid-Backup-Passphrase")).toBe("portable-password");
    expect(headers.get("X-FitGrid-Backup-Size")).toBe("8192");
  });

  it("uses typed maintenance paths and returns a navigable one-time download URL", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ items: [] }))
      .mockResolvedValueOnce(Response.json({
        id: JOB_ID,
        type: "backup",
        state: "dumping",
        requestId: "01JOB",
        updatedAt: "2026-09-03T07:00:00.000Z",
      }))
      .mockResolvedValueOnce(Response.json({ token: "token /?" }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({
        id: JOB_ID,
        type: "restore",
        state: "queued",
        requestId: "01RESTORE",
      }, { status: 202 }));
    vi.stubGlobal("fetch", fetcher);

    await listPortableBackups();
    await getMaintenanceJob(JOB_ID);
    await expect(issueBackupDownload("backup/id")).resolves.toBe(
      "/api/v1/admin/backups/backup%2Fid/download?token=token%20%2F%3F",
    );
    await confirmRestore(JOB_ID, {
      currentPassword: "current-password",
      confirmationPhrase: "恢复全部数据",
    });

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/admin/backups",
      `/api/v1/admin/maintenance/jobs/${JOB_ID}`,
      "/api/v1/admin/backups/backup%2Fid/download-token",
      `/api/v1/admin/restores/${JOB_ID}/confirm`,
    ]);
    expect((fetcher.mock.calls[2]?.[1] as RequestInit).method).toBe("POST");
    expect((fetcher.mock.calls[3]?.[1] as RequestInit).body).toBe(JSON.stringify({
      currentPassword: "current-password",
      confirmationPhrase: "恢复全部数据",
    }));
  });
});
