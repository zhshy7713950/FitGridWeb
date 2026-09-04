import { mkdtemp, open, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/server/http/api-error";

const { getRuntimeServices, tokenConsume } = vi.hoisted(() => ({
  getRuntimeServices: vi.fn(),
  tokenConsume: vi.fn(),
}));
vi.mock("@/server/runtime/services", () => ({ getRuntimeServices }));
vi.mock("@/server/security/request-protection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/security/request-protection")>();
  return { ...actual, tokenIssueRequests: { consume: tokenConsume } };
});

import * as downloadRoute from "./[backupId]/download/route";
import * as tokenRoute from "./[backupId]/download-token/route";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ADMIN_ID = "99999999-9999-4999-8999-999999999999";
const BACKUP_ID = "backup-20260903";
const REQUEST_ID = "request_admin_download_0001";
const roots: string[] = [];

afterEach(async () => {
  getRuntimeServices.mockReset();
  tokenConsume.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("administrator backup download", () => {
  it("does not return a token until the root audit is durable", async () => {
    let releaseAudit: (() => void) | undefined;
    const auditPersist = vi.fn(() => new Promise<void>((resolve) => {
      releaseAudit = resolve;
    }));
    const files = await downloadFixture({ auditPersist });
    getRuntimeServices.mockReturnValue(files.services);

    const responsePromise = tokenRoute.POST(
      mutationRequest(`/backups/${BACKUP_ID}/download-token`),
      params(),
    );
    let settled = false;
    void responsePromise.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(auditPersist).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(auditPersist).toHaveBeenCalledWith({
      event: "download-token-issued",
      actorId: ADMIN_ID,
      requestId: REQUEST_ID,
      backupId: BACKUP_ID,
    });
    expect(JSON.stringify(auditPersist.mock.calls)).not.toContain("issued-download-token");

    releaseAudit!();
    const response = await responsePromise;
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ token: "issued-download-token" });
  });

  it("fails closed without returning a token when root audit persistence fails", async () => {
    const auditPersist = vi.fn().mockRejectedValue(new Error("root audit unavailable"));
    const files = await downloadFixture({ auditPersist });
    getRuntimeServices.mockReturnValue(files.services);

    const response = await tokenRoute.POST(
      mutationRequest(`/backups/${BACKUP_ID}/download-token`),
      params(),
    );
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(serialized).toContain("INTERNAL_ERROR");
    expect(serialized).not.toContain("issued-download-token");
  });

  it("issues a no-store token only after confirming the backup exists", async () => {
    const files = await downloadFixture();
    getRuntimeServices.mockReturnValue(files.services);

    const response = await tokenRoute.POST(
      mutationRequest(`/backups/${BACKUP_ID}/download-token`),
      params(),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    const body = await response.json();
    expect(body).toEqual({ token: expect.any(String) });
    expect(files.getBackupFile).toHaveBeenCalledWith(BACKUP_ID);
    expect(files.tokenService.issue).toHaveBeenCalledWith({ adminId: ADMIN_ID, backupId: BACKUP_ID });
    expect(tokenConsume).toHaveBeenCalledWith(ADMIN_ID);
  });

  it("rejects anonymous token issue before touching backup history", async () => {
    const files = await downloadFixture({ session: null });
    getRuntimeServices.mockReturnValue(files.services);

    const response = await tokenRoute.POST(
      mutationRequest(`/backups/${BACKUP_ID}/download-token`),
      params(),
    );

    expect(response.status).toBe(401);
    expect(files.getBackupFile).not.toHaveBeenCalled();
    expect(files.tokenService.issue).not.toHaveBeenCalled();
  });

  it("consumes the token before opening a no-store, nosniff attachment and rejects replay", async () => {
    const files = await downloadFixture({ realTokens: true });
    getRuntimeServices.mockReturnValue(files.services);
    const token = files.tokenService.issue({ adminId: ADMIN_ID, backupId: BACKUP_ID });

    const first = await downloadRoute.GET(downloadRequest(token), params());

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store, private");
    expect(first.headers.get("content-type")).toBe("application/vnd.fitgrid.backup");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("content-disposition"))
      .toBe('attachment; filename="fitgridweb-20260903T070000Z.fitgridbackup"');
    expect(await first.text()).toBe("encrypted-portable-backup");
    expect(files.auditPersist).toHaveBeenCalledWith({
      event: "download-completed",
      actorId: ADMIN_ID,
      requestId: REQUEST_ID,
      backupId: BACKUP_ID,
    });

    const replay = await downloadRoute.GET(downloadRequest(token), params());
    expect(replay.status).toBe(404);
    await expect(replay.json()).resolves.toMatchObject({
      code: "BACKUP_NOT_FOUND",
      requestId: REQUEST_ID,
    });
  });

  it("withholds the final bytes until the completion audit is durable", async () => {
    let releaseAudit: (() => void) | undefined;
    const auditPersist = vi.fn(() => new Promise<void>((resolve) => {
      releaseAudit = resolve;
    }));
    const files = await downloadFixture({ auditPersist });
    getRuntimeServices.mockReturnValue(files.services);

    const response = await downloadRoute.GET(downloadRequest("issued-download-token"), params());
    const reader = response.body!.getReader();
    const finalRead = reader.read();
    let finalReadSettled = false;
    void finalRead.then(() => {
      finalReadSettled = true;
    });

    await vi.waitFor(() => expect(auditPersist).toHaveBeenCalledOnce());
    expect(finalReadSettled).toBe(false);
    releaseAudit!();

    const chunk = await finalRead;
    expect(new TextDecoder().decode(chunk.value)).toBe("encrypted-portable-backup");
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("does not deliver a complete archive when completion audit persistence fails", async () => {
    const files = await downloadFixture({
      auditPersist: vi.fn().mockRejectedValue(new Error("root audit unavailable")),
    });
    getRuntimeServices.mockReturnValue(files.services);

    const response = await downloadRoute.GET(downloadRequest("issued-download-token"), params());

    await expect(response.arrayBuffer()).rejects.toThrow("root audit unavailable");
  });

  it("returns 404 instead of 200 when the archive disappears after token consumption", async () => {
    const files = await downloadFixture({
      afterConsume: async (archive) => unlink(archive),
    });
    getRuntimeServices.mockReturnValue(files.services);

    const response = await downloadRoute.GET(downloadRequest("issued-download-token"), params());
    if (response.status === 200) await response.body?.cancel().catch(() => undefined);

    expect(files.tokenService.consume).toHaveBeenCalledOnce();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "BACKUP_NOT_FOUND" });
  });

  it("refuses a symlink substituted after token consumption without reading its target", async () => {
    const files = await downloadFixture({
      afterConsume: async (archive, root) => {
        const secret = path.join(root, "outside-secret");
        await writeFile(secret, "do-not-download", { mode: 0o600 });
        await unlink(archive);
        await symlink(secret, archive);
      },
    });
    getRuntimeServices.mockReturnValue(files.services);

    const response = await downloadRoute.GET(downloadRequest("issued-download-token"), params());
    if (response.status === 200) await response.body?.cancel().catch(() => undefined);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "BACKUP_NOT_FOUND" });
  });

  it("refuses a same-size regular file replacement when its inode is reused", async () => {
    const files = await downloadFixture({
      afterConsume: async (archive, _root, file) => {
        await unlink(archive);
        await writeFile(archive, "replacement-file-content!", { mode: 0o600 });
        const replacement = await stat(archive);
        file.dev = replacement.dev;
        file.ino = replacement.ino;
      },
    });
    getRuntimeServices.mockReturnValue(files.services);

    const response = await downloadRoute.GET(downloadRequest("issued-download-token"), params());
    if (response.status === 200) await response.body?.cancel().catch(() => undefined);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "BACKUP_NOT_FOUND" });
  });

  it("closes the already-open archive handle when the web response is cancelled", async () => {
    const files = await downloadFixture();
    getRuntimeServices.mockReturnValue(files.services);
    const probe = await open(files.archivePath, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      createReadStream: typeof probe.createReadStream;
    };
    await probe.close();
    const originalCreateReadStream = prototype.createReadStream;
    let closeStream: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      closeStream = resolve;
    });
    const createReadStream = vi.spyOn(prototype, "createReadStream").mockImplementation(function (
      this: typeof probe,
      options,
    ) {
      const stream = Reflect.apply(originalCreateReadStream, this, [options]);
      stream.once("close", closeStream!);
      return stream;
    });

    try {
      const response = await downloadRoute.GET(downloadRequest("issued-download-token"), params());
      expect(response.status).toBe(200);
      expect(createReadStream).toHaveBeenCalledOnce();
      await response.body?.cancel();
      await closed;
      expect(files.auditPersist).not.toHaveBeenCalled();
    } finally {
      createReadStream.mockRestore();
    }
  });

  it("closes the already-open archive handle when the file stream errors", async () => {
    const files = await downloadFixture();
    getRuntimeServices.mockReturnValue(files.services);
    const probe = await open(files.archivePath, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      createReadStream: typeof probe.createReadStream;
    };
    await probe.close();
    const originalCreateReadStream = prototype.createReadStream;
    let openedStream: ReturnType<typeof probe.createReadStream> | undefined;
    let closeStream: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      closeStream = resolve;
    });
    const createReadStream = vi.spyOn(prototype, "createReadStream").mockImplementation(function (
      this: typeof probe,
      options,
    ) {
      openedStream = Reflect.apply(originalCreateReadStream, this, [options]);
      openedStream.once("close", closeStream!);
      return openedStream;
    });

    try {
      const response = await downloadRoute.GET(downloadRequest("issued-download-token"), params());
      expect(response.status).toBe(200);
      const reading = response.arrayBuffer();
      openedStream!.destroy(new Error("simulated archive read failure"));
      await expect(reading).rejects.toThrow("simulated archive read failure");
      await closed;
      expect(files.auditPersist).not.toHaveBeenCalled();
    } finally {
      createReadStream.mockRestore();
    }
  });

  it("does not burn a token when rejecting a Range request", async () => {
    const files = await downloadFixture({ realTokens: true });
    getRuntimeServices.mockReturnValue(files.services);
    const token = files.tokenService.issue({ adminId: ADMIN_ID, backupId: BACKUP_ID });

    const ranged = await downloadRoute.GET(downloadRequest(token, { Range: "bytes=0-3" }), params());
    expect(ranged.status).toBe(416);
    await expect(ranged.json()).resolves.toMatchObject({ code: "RANGE_NOT_SUPPORTED" });

    const full = await downloadRoute.GET(downloadRequest(token), params());
    expect(full.status).toBe(200);
    expect(await full.text()).toBe("encrypted-portable-backup");
  });

  it("binds downloads to the active administrator", async () => {
    const files = await downloadFixture({ realTokens: true });
    getRuntimeServices.mockReturnValue(files.services);
    const token = files.tokenService.issue({ adminId: ADMIN_ID, backupId: BACKUP_ID });
    files.getSession.mockResolvedValueOnce(sessionFor(OTHER_ADMIN_ID));

    const mismatch = await downloadRoute.GET(downloadRequest(token), params());
    expect(mismatch.status).toBe(404);
    await expect(mismatch.json()).resolves.toMatchObject({ code: "BACKUP_NOT_FOUND" });
  });

  it.each([
    [null, 401],
    [sessionFor(ADMIN_ID, "member", "active"), 403],
    [sessionFor(ADMIN_ID, "admin", "disabled"), 401],
  ])("rejects an unauthorized download before backup or token access", async (session, status) => {
    const files = await downloadFixture({ session });
    getRuntimeServices.mockReturnValue(files.services);

    const response = await downloadRoute.GET(downloadRequest("unused-token"), params());

    expect(response.status).toBe(status);
    expect(files.getBackupFile).not.toHaveBeenCalled();
    expect(files.tokenService.consume).not.toHaveBeenCalled();
  });

  it("returns 503 without resolving a file or consuming a token during maintenance", async () => {
    const files = await downloadFixture({ maintenanceActive: true });
    getRuntimeServices.mockReturnValue(files.services);

    const response = await downloadRoute.GET(downloadRequest("unused-token"), params());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(files.getBackupFile).not.toHaveBeenCalled();
    expect(files.tokenService.consume).not.toHaveBeenCalled();
  });

  it("maps a missing backup artifact to the same safe 404 as an invalid token", async () => {
    const files = await downloadFixture({
      getBackupFile: vi.fn().mockRejectedValue(new ApiError(
        404,
        "MAINTENANCE_NOT_FOUND",
        "维护任务或备份不存在",
      )),
    });
    getRuntimeServices.mockReturnValue(files.services);

    const response = await downloadRoute.GET(downloadRequest("unused-token"), params());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "BACKUP_NOT_FOUND" });
  });

  it("returns a safe 404 for a missing artifact without exposing its path", async () => {
    const files = await downloadFixture({
      getBackupFile: vi.fn().mockRejectedValue(new Error("ENOENT /var/lib/private-host/backup")),
    });
    getRuntimeServices.mockReturnValue(files.services);

    const response = await downloadRoute.GET(downloadRequest("syntactically-valid-token"), params());
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(serialized).toContain("INTERNAL_ERROR");
    expect(serialized).not.toContain("/var/lib/private-host/backup");
  });
});

async function downloadFixture({
  session = sessionFor(ADMIN_ID),
  realTokens = false,
  maintenanceActive = false,
  getBackupFile,
  afterConsume,
  auditPersist = vi.fn().mockResolvedValue(undefined),
}: {
  session?: unknown;
  realTokens?: boolean;
  maintenanceActive?: boolean;
  getBackupFile?: ReturnType<typeof vi.fn>;
  afterConsume?: (
    archivePath: string,
    root: string,
    file: { dev: number; ino: number },
  ) => Promise<void>;
  auditPersist?: ReturnType<typeof vi.fn>;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "fitgrid-route-download-"));
  roots.push(root);
  const archivePath = path.join(root, "fitgridweb-20260903T070000Z.fitgridbackup");
  await writeFile(archivePath, "encrypted-portable-backup", { mode: 0o600 });
  const archiveInfo = await stat(archivePath);
  const file = {
    id: BACKUP_ID,
    name: "fitgridweb-20260903T070000Z.fitgridbackup",
    path: archivePath,
    createdAt: "2026-09-03T07:00:00.000Z",
    size: 25,
    sha256: "a".repeat(64),
    dev: archiveInfo.dev,
    ino: archiveInfo.ino,
    ctimeMs: archiveInfo.ctimeMs,
  };
  const consumed = new Set<string>();
  const actualTokenService = {
    issue: vi.fn(({ adminId, backupId }: { adminId: string; backupId: string }) =>
      `token-for-${adminId}-${backupId}`),
    consume: vi.fn(async (token: string, adminId: string, backupId: string) => {
      if (token !== `token-for-${adminId}-${backupId}` || consumed.has(token)) {
        throw new ApiError(404, "BACKUP_NOT_FOUND", "备份不存在或下载链接已失效");
      }
      consumed.add(token);
    }),
  };
  const tokenService = realTokens ? actualTokenService : {
    issue: vi.fn().mockReturnValue("issued-download-token"),
    consume: vi.fn(async () => afterConsume?.(archivePath, root, file)),
  };
  const getSession = vi.fn().mockResolvedValue(session);
  const resolvedGetBackupFile = getBackupFile ?? vi.fn().mockResolvedValue(file);
  return {
    archivePath,
    getSession,
    getBackupFile: resolvedGetBackupFile,
    tokenService,
    auditPersist,
    services: {
      auth: { api: { getSession } },
      maintenance: {
        getMaintenanceMode: vi.fn().mockResolvedValue(maintenanceActive ? {
          active: true,
          jobId: "22222222-2222-4222-8222-222222222222",
          updatedAt: "2026-09-03T07:00:00.000Z",
        } : null),
        getBackupFile: resolvedGetBackupFile,
      },
      downloadTokens: tokenService,
      downloadAudits: { persist: auditPersist },
    },
  };
}

function sessionFor(
  id: string,
  role: "member" | "admin" = "admin",
  status: "active" | "disabled" = "active",
) {
  return { user: { id, name: "admin", username: "admin", role, status } };
}

function params(backupId = BACKUP_ID) {
  return { params: Promise.resolve({ backupId }) };
}

function mutationRequest(urlPath: string): Request {
  return new Request(`https://fitgrid.example/api/v1/admin${urlPath}`, {
    method: "POST",
    headers: {
      Host: "fitgrid.example",
      Origin: "https://fitgrid.example",
      "X-Request-Id": REQUEST_ID,
    },
  });
}

function downloadRequest(token: string, overrides: Record<string, string> = {}): Request {
  return new Request(
    `https://fitgrid.example/api/v1/admin/backups/${BACKUP_ID}/download?token=${encodeURIComponent(token)}`,
    {
      headers: {
        Host: "fitgrid.example",
        Origin: "https://fitgrid.example",
        "X-Request-Id": REQUEST_ID,
        ...overrides,
      },
    },
  );
}
