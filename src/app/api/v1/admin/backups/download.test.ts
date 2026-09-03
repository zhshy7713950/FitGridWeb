import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

    const replay = await downloadRoute.GET(downloadRequest(token), params());
    expect(replay.status).toBe(404);
    await expect(replay.json()).resolves.toMatchObject({
      code: "BACKUP_NOT_FOUND",
      requestId: REQUEST_ID,
    });
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
}: {
  session?: unknown;
  realTokens?: boolean;
  maintenanceActive?: boolean;
  getBackupFile?: ReturnType<typeof vi.fn>;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "fitgrid-route-download-"));
  roots.push(root);
  const archivePath = path.join(root, "fitgridweb-20260903T070000Z.fitgridbackup");
  await writeFile(archivePath, "encrypted-portable-backup", { mode: 0o600 });
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
    consume: vi.fn().mockResolvedValue(undefined),
  };
  const getSession = vi.fn().mockResolvedValue(session);
  const file = {
    id: BACKUP_ID,
    name: "fitgridweb-20260903T070000Z.fitgridbackup",
    path: archivePath,
    createdAt: "2026-09-03T07:00:00.000Z",
    size: 25,
    sha256: "a".repeat(64),
  };
  const resolvedGetBackupFile = getBackupFile ?? vi.fn().mockResolvedValue(file);
  return {
    getSession,
    getBackupFile: resolvedGetBackupFile,
    tokenService,
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
