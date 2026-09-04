// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkMaintenanceHealth,
  confirmRestore,
  createPortableBackup,
  getMaintenanceJob,
  issueBackupDownload,
  listPortableBackups,
  uploadRestoreForInspection,
} from "./maintenance-api";
import { resetDemoMaintenanceDataForTests } from "./demo-maintenance-data";

const JOB_ID = "00000000-0000-4000-8000-000000000031";

afterEach(() => {
  resetDemoMaintenanceDataForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("administrator maintenance client", () => {
  it("runs every maintenance operation through deterministic demo state without HTTP or secrets", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
    const fetcher = vi.fn().mockResolvedValue(Response.json({ items: [] }));
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    vi.stubGlobal("fetch", fetcher);
    const currentPassword = "demo-current-secret";
    const backupPassword = "demo-portable-secret";
    const restorePassword = "demo-restore-secret";

    const initial = await listPortableBackups();
    expect(initial.items).toHaveLength(2);

    const queuedBackup = await createPortableBackup({
      currentPassword,
      backupPassword,
      confirmBackupPassword: backupPassword,
    });
    expect(queuedBackup.id).toBe("10000000-0000-4000-8000-000000000001");
    const backupStages = await Promise.all([
      getMaintenanceJob(queuedBackup.id),
      getMaintenanceJob(queuedBackup.id),
      getMaintenanceJob(queuedBackup.id),
    ]);
    expect(backupStages.map(({ state }) => state)).toEqual(["dumping", "encrypting", "ready"]);
    const updated = await listPortableBackups();
    expect(updated.items).toHaveLength(3);
    expect(updated.items[0].createdAt > initial.items[0].createdAt).toBe(true);
    await expect(issueBackupDownload(updated.items[0].id)).resolves.toMatch(
      /^data:application\/vnd\.fitgrid\.backup/,
    );

    const stream = vi.fn(() => new ReadableStream<Uint8Array>());
    const archive = {
      name: "fitgridweb-20260903T070000Z.fitgridbackup",
      size: 8_192,
      stream,
    } as unknown as File;
    const queuedInspection = await uploadRestoreForInspection(archive, restorePassword);
    expect(queuedInspection.id).toBe("20000000-0000-4000-8000-000000000001");
    const inspectionStages = await Promise.all([
      getMaintenanceJob(queuedInspection.id),
      getMaintenanceJob(queuedInspection.id),
      getMaintenanceJob(queuedInspection.id),
    ]);
    expect(inspectionStages.map(({ state }) => state)).toEqual([
      "uploading",
      "inspecting",
      "awaiting-confirmation",
    ]);
    const verified = inspectionStages[2];
    expect(verified).toMatchObject({
      backupCreatedAt: "2026-09-03T06:30:00.000Z",
      postgresMajor: 17,
      database: "fitgridweb",
      preview: { users: 3, gridTrades: 24, invitations: 2, importPreviews: 1 },
    });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.preview)).toBe(true);
    expect(verified).not.toHaveProperty("size");
    expect(verified).not.toHaveProperty("appImage");

    const queuedRestore = await confirmRestore(queuedInspection.id, {
      currentPassword,
      confirmationPhrase: "恢复全部数据",
    });
    expect(queuedRestore.id).toBe("30000000-0000-4000-8000-000000000001");
    const restoreStages = await Promise.all([
      getMaintenanceJob(queuedRestore.id),
      getMaintenanceJob(queuedRestore.id),
      getMaintenanceJob(queuedRestore.id),
    ]);
    expect(restoreStages.map(({ state }) => state)).toEqual(["restoring", "checking", "succeeded"]);
    await expect(checkMaintenanceHealth()).resolves.toBe(true);

    const serializedResults = JSON.stringify({
      initial,
      queuedBackup,
      backupStages,
      updated,
      queuedInspection,
      inspectionStages,
      queuedRestore,
      restoreStages,
    });
    for (const secret of [currentPassword, backupPassword, restorePassword]) {
      expect(serializedResults).not.toContain(secret);
      expect(JSON.stringify(window.localStorage)).not.toContain(secret);
      expect(JSON.stringify(window.sessionStorage)).not.toContain(secret);
    }
    expect(storageWrite).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("honors pre-aborted signals for every demo maintenance operation", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    controller.abort();
    const archive = {
      name: "fitgridweb-20260903T070000Z.fitgridbackup",
      size: 8_192,
      stream: vi.fn(),
    } as unknown as File;
    const operations = [
      () => listPortableBackups(controller.signal),
      () => createPortableBackup({
        currentPassword: "current-password",
        backupPassword: "portable-password",
        confirmBackupPassword: "portable-password",
      }, controller.signal),
      () => getMaintenanceJob(JOB_ID, controller.signal),
      () => issueBackupDownload("demo-backup-01", controller.signal),
      () => uploadRestoreForInspection(archive, "portable-password", controller.signal),
      () => confirmRestore(JOB_ID, {
        currentPassword: "current-password",
        confirmationPhrase: "恢复全部数据",
      }, controller.signal),
      () => checkMaintenanceHealth(controller.signal),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({ name: "AbortError" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not let a production demo flag bypass any authoritative maintenance endpoint", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        id: JOB_ID, type: "backup", state: "queued", requestId: "01BACKUP",
      }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ items: [] }))
      .mockResolvedValueOnce(Response.json({
        id: JOB_ID, type: "backup", state: "dumping", requestId: "01JOB",
        updatedAt: "2026-09-03T07:00:00.000Z",
      }))
      .mockResolvedValueOnce(Response.json({ token: "real-token" }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({
        id: JOB_ID, type: "inspect-restore", state: "queued", requestId: "01UPLOAD",
      }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({
        id: JOB_ID, type: "restore", state: "queued", requestId: "01RESTORE",
      }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ status: "ok", database: "ok" }));
    vi.stubGlobal("fetch", fetcher);
    const archive = {
      name: "fitgridweb-20260903T070000Z.fitgridbackup",
      size: 8_192,
      stream: vi.fn(() => new ReadableStream<Uint8Array>()),
    } as unknown as File;

    await createPortableBackup({
      currentPassword: "current-password",
      backupPassword: "portable-password",
      confirmBackupPassword: "portable-password",
    });
    await listPortableBackups();
    await getMaintenanceJob(JOB_ID);
    await issueBackupDownload("real-backup");
    await uploadRestoreForInspection(archive, "portable-password");
    await confirmRestore(JOB_ID, {
      currentPassword: "current-password",
      confirmationPhrase: "恢复全部数据",
    });
    await checkMaintenanceHealth();

    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/admin/backups",
      "/api/v1/admin/backups",
      `/api/v1/admin/maintenance/jobs/${JOB_ID}`,
      "/api/v1/admin/backups/real-backup/download-token",
      "/api/v1/admin/restores/uploads?fileName=fitgridweb-20260903T070000Z.fitgridbackup",
      `/api/v1/admin/restores/${JOB_ID}/confirm`,
      "/api/v1/health",
    ]);
  });

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

    await uploadRestoreForInspection(file, "中文备份密码🔐安全恢复十二");

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
    expect(headers.get("X-FitGrid-Backup-Passphrase")).toBe(
      "5Lit5paH5aSH5Lu95a-G56CB8J-UkOWuieWFqOaBouWkjeWNgeS6jA",
    );
    expect(headers.get("X-FitGrid-Backup-Passphrase-Encoding")).toBe("base64url-utf8");
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
