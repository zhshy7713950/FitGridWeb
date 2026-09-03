import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  backupConsume,
  confirmConsume,
  getRuntimeServices,
  inspectionConsume,
  statusConsume,
  tokenConsume,
} = vi.hoisted(() => ({
  backupConsume: vi.fn(),
  confirmConsume: vi.fn(),
  getRuntimeServices: vi.fn(),
  inspectionConsume: vi.fn(),
  statusConsume: vi.fn(),
  tokenConsume: vi.fn(),
}));

vi.mock("@/server/runtime/services", () => ({ getRuntimeServices }));
vi.mock("@/server/security/request-protection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/security/request-protection")>();
  return {
    ...actual,
    backupCreationRequests: { consume: backupConsume },
    maintenanceStatusRequests: { consume: statusConsume },
    restoreConfirmationRequests: { consume: confirmConsume },
    restoreInspectionRequests: { consume: inspectionConsume },
    tokenIssueRequests: { consume: tokenConsume },
  };
});

import * as download from "@/app/api/v1/admin/backups/[backupId]/download/route";
import * as downloadToken from "@/app/api/v1/admin/backups/[backupId]/download-token/route";
import * as backups from "@/app/api/v1/admin/backups/route";
import * as job from "@/app/api/v1/admin/maintenance/jobs/[jobId]/route";
import * as confirm from "@/app/api/v1/admin/restores/[restoreId]/confirm/route";
import * as upload from "@/app/api/v1/admin/restores/uploads/route";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const RESTORE_ID = "33333333-3333-4333-8333-333333333333";
const BACKUP_ID = "portable-backup-id";
const REQUEST_ID = "maintenance_origin_matrix_0001";
const FILE_NAME = "fitgridweb-20260903T070000Z.fitgridbackup";

let root: string;
let archivePath: string;
let archiveIdentity: { dev: number; ino: number };

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fitgrid-origin-routes-"));
  archivePath = path.join(root, FILE_NAME);
  await writeFile(archivePath, "portable-archive", { mode: 0o600 });
  const info = await stat(archivePath);
  archiveIdentity = { dev: info.dev, ino: info.ino };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const mock of [
    backupConsume,
    confirmConsume,
    getRuntimeServices,
    inspectionConsume,
    statusConsume,
    tokenConsume,
  ]) mock.mockReset();
});

type Operation = {
  name: string;
  invoke: (headers: HeadersInit) => Promise<Response>;
};

function operations(): Operation[] {
  return [
    {
      name: "backup creation",
      invoke: (headers) => backups.POST(request("/backups", "POST", headers, {
        currentPassword: "current-password",
        backupPassword: "portable-password",
        confirmBackupPassword: "portable-password",
      })),
    },
    {
      name: "backup history",
      invoke: (headers) => backups.GET(request("/backups", "GET", headers)),
    },
    {
      name: "download token issue",
      invoke: (headers) => downloadToken.POST(
        request(`/backups/${BACKUP_ID}/download-token`, "POST", headers),
        { params: Promise.resolve({ backupId: BACKUP_ID }) },
      ),
    },
    {
      name: "backup download",
      invoke: (headers) => download.GET(
        request(`/backups/${BACKUP_ID}/download?token=download-token`, "GET", headers),
        { params: Promise.resolve({ backupId: BACKUP_ID }) },
      ),
    },
    {
      name: "restore upload",
      invoke: (headers) => upload.POST(uploadRequest(headers)),
    },
    {
      name: "restore confirmation",
      invoke: (headers) => confirm.POST(
        request(`/restores/${RESTORE_ID}/confirm`, "POST", headers, {
          currentPassword: "current-password",
          confirmationPhrase: "恢复全部数据",
        }),
        { params: Promise.resolve({ restoreId: RESTORE_ID }) },
      ),
    },
    {
      name: "maintenance job status",
      invoke: (headers) => job.GET(
        request(`/maintenance/jobs/${JOB_ID}`, "GET", headers),
        { params: Promise.resolve({ jobId: JOB_ID }) },
      ),
    },
  ];
}

describe("maintenance route authorization and same-origin matrix", () => {
  it.each([
    ["anonymous", null, 401],
    ["member", user("member", "active"), 403],
    ["disabled administrator", user("admin", "disabled"), 401],
  ])("authorizes %s before origin validation or maintenance access", async (_role, session, expected) => {
    for (const operation of operations()) {
      const services = servicesFor(session);
      getRuntimeServices.mockReturnValue(services);

      const response = await operation.invoke(headers({ Origin: "https://evil.example" }));
      await response.body?.cancel().catch(() => undefined);

      expect(response.status, operation.name).toBe(expected);
      expectNoMaintenanceAccess(services, operation.name);
    }
  });

  it("rejects every explicit cross-origin maintenance request after authorization", async () => {
    for (const operation of operations()) {
      const services = servicesFor(user("admin", "active"));
      getRuntimeServices.mockReturnValue(services);

      const response = await operation.invoke(headers({ Origin: "https://evil.example" }));

      expect(response.status, operation.name).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "CROSS_SITE_REQUEST",
        requestId: REQUEST_ID,
      });
      expectNoMaintenanceAccess(services, operation.name);
    }
  });

  it("allows every same-origin fetch-metadata request when browsers omit Origin", async () => {
    for (const operation of operations()) {
      const services = servicesFor(user("admin", "active"));
      getRuntimeServices.mockReturnValue(services);

      const response = await operation.invoke(headers({ "Sec-Fetch-Site": "same-origin" }, false));

      expect(response.status, operation.name).toBeLessThan(300);
      if (operation.name === "backup download") await response.arrayBuffer();
      else await response.body?.cancel().catch(() => undefined);
    }
  });

  it("allows a same-origin Referer without Origin or Fetch Metadata", async () => {
    const services = servicesFor(user("admin", "active"));
    getRuntimeServices.mockReturnValue(services);

    const response = await backups.GET(headersRequest("/backups", {
      Referer: "https://fitgrid.example/admin",
    }));

    expect(response.status).toBe(200);
  });

  it("allows an explicit user navigation without Origin while rejecting missing provenance", async () => {
    const navigationServices = servicesFor(user("admin", "active"));
    getRuntimeServices.mockReturnValueOnce(navigationServices);
    const navigation = await backups.GET(headersRequest("/backups", {
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    }));
    expect(navigation.status).toBe(200);

    const missingServices = servicesFor(user("admin", "active"));
    getRuntimeServices.mockReturnValueOnce(missingServices);
    const missing = await backups.GET(headersRequest("/backups", {}));
    expect(missing.status).toBe(403);
    expectNoMaintenanceAccess(missingServices, "missing provenance");
  });

  it.each(["cross-site", "same-site"])("rejects explicit Sec-Fetch-Site=%s before maintenance access", async (site) => {
    const services = servicesFor(user("admin", "active"));
    getRuntimeServices.mockReturnValue(services);

    const response = await job.GET(
      headersRequest(`/maintenance/jobs/${JOB_ID}`, { "Sec-Fetch-Site": site }),
      { params: Promise.resolve({ jobId: JOB_ID }) },
    );

    expect(response.status).toBe(403);
    expect(services.maintenance.getJob).not.toHaveBeenCalled();
  });
});

function servicesFor(session: unknown) {
  const file = {
    id: BACKUP_ID,
    name: FILE_NAME,
    path: archivePath,
    createdAt: "2026-09-03T07:00:00.000Z",
    size: 16,
    sha256: "a".repeat(64),
    ...archiveIdentity,
  };
  return {
    auth: {
      api: {
        getSession: vi.fn().mockResolvedValue(session),
        verifyPassword: vi.fn().mockResolvedValue({ status: true }),
      },
    },
    maintenance: {
      confirmRestore: vi.fn().mockResolvedValue(queued("restore")),
      createBackup: vi.fn().mockResolvedValue(queued("backup")),
      getBackupFile: vi.fn().mockResolvedValue(file),
      getJob: vi.fn().mockImplementation(async (id: string) => id === RESTORE_ID
        ? {
            id: RESTORE_ID,
            type: "inspect-restore",
            state: "awaiting-confirmation",
            requestId: REQUEST_ID,
            updatedAt: "2026-09-03T07:00:00.000Z",
            expiresAt: Math.floor(Date.now() / 1_000) + 600,
            backupCreatedAt: "2026-09-03T06:30:00.000Z",
            postgresMajor: 17,
            database: "fitgridweb",
            preview: { users: 2, gridTrades: 24, invitations: 1, importPreviews: 0 },
          }
        : {
            id: JOB_ID,
            type: "restore",
            state: "restoring",
            requestId: REQUEST_ID,
            updatedAt: "2026-09-03T07:00:00.000Z",
          }),
      getMaintenanceMode: vi.fn().mockResolvedValue(null),
      listBackups: vi.fn().mockResolvedValue([]),
      writeUpload: vi.fn().mockResolvedValue(queued("inspect-restore")),
    },
    downloadTokens: {
      consume: vi.fn().mockResolvedValue(undefined),
      issue: vi.fn().mockReturnValue("download-token"),
    },
  };
}

function expectNoMaintenanceAccess(services: ReturnType<typeof servicesFor>, label: string): void {
  for (const operation of [
    services.maintenance.confirmRestore,
    services.maintenance.createBackup,
    services.maintenance.getBackupFile,
    services.maintenance.getJob,
    services.maintenance.getMaintenanceMode,
    services.maintenance.listBackups,
    services.maintenance.writeUpload,
    services.downloadTokens.consume,
    services.downloadTokens.issue,
  ]) expect(operation, label).not.toHaveBeenCalled();
}

function queued(type: "backup" | "inspect-restore" | "restore") {
  return { id: JOB_ID, type, state: "queued", requestId: REQUEST_ID };
}

function user(role: "member" | "admin", status: "active" | "disabled") {
  return { user: { id: ADMIN_ID, name: "admin", username: "admin", role, status } };
}

function headers(overrides: HeadersInit = {}, includeOrigin = true): Headers {
  return new Headers({
    Host: "fitgrid.example",
    "X-Forwarded-Proto": "https",
    "X-Request-Id": REQUEST_ID,
    ...(includeOrigin ? { Origin: "https://fitgrid.example" } : {}),
    ...Object.fromEntries(new Headers(overrides)),
  });
}

function headersRequest(urlPath: string, overrides: HeadersInit): Request {
  return request(urlPath, "GET", headers(overrides, false));
}

function request(urlPath: string, method: string, requestHeaders: HeadersInit, body?: unknown): Request {
  return new Request(`https://fitgrid.example/api/v1/admin${urlPath}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...Object.fromEntries(new Headers(requestHeaders)),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function uploadRequest(requestHeaders: HeadersInit): Request {
  return new Request(
    `https://fitgrid.example/api/v1/admin/restores/uploads?fileName=${FILE_NAME}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.fitgrid.backup",
        "X-FitGrid-Backup-Passphrase": "portable-password",
        "X-FitGrid-Backup-Size": "3",
        ...Object.fromEntries(new Headers(requestHeaders)),
      },
      body: new Uint8Array([1, 2, 3]),
      duplex: "half",
    } as RequestInit & { duplex: "half" },
  );
}
