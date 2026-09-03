import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/server/http/api-error";

const { backupConsume, getRuntimeServices, statusConsume } = vi.hoisted(() => ({
  backupConsume: vi.fn(),
  getRuntimeServices: vi.fn(),
  statusConsume: vi.fn(),
}));

vi.mock("@/server/runtime/services", () => ({ getRuntimeServices }));
vi.mock("@/server/security/request-protection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/security/request-protection")>();
  return {
    ...actual,
    backupCreationRequests: { consume: backupConsume },
    maintenanceStatusRequests: { consume: statusConsume },
  };
});

import * as jobRoute from "@/app/api/v1/admin/maintenance/jobs/[jobId]/route";
import { GET, POST } from "./route";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "request_admin_backup_0001";

afterEach(() => {
  backupConsume.mockReset();
  getRuntimeServices.mockReset();
  statusConsume.mockReset();
});

describe("/api/v1/admin/backups", () => {
  it.each([
    ["anonymous", null, 401, "UNAUTHORIZED"],
    ["member", sessionUser("member", "active"), 403, "FORBIDDEN"],
    ["disabled-admin", sessionUser("admin", "disabled"), 401, "UNAUTHORIZED"],
  ])("rejects %s before touching the maintenance spool", async (_label, session, status, code) => {
    const services = servicesFor({ session });
    getRuntimeServices.mockReturnValue(services);

    const response = await POST(backupRequest());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ code, requestId: REQUEST_ID });
    expect(services.maintenance.getMaintenanceMode).not.toHaveBeenCalled();
    expect(services.maintenance.createBackup).not.toHaveBeenCalled();
    expect(services.auth.api.verifyPassword).not.toHaveBeenCalled();
  });

  it("authenticates before rejecting cross-site creation and never touches the spool", async () => {
    const services = servicesFor();
    getRuntimeServices.mockReturnValue(services);
    const response = await POST(backupRequest(undefined, { Origin: "https://evil.example" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "CROSS_SITE_REQUEST",
      requestId: REQUEST_ID,
    });
    expect(services.auth.api.getSession).toHaveBeenCalledOnce();
    expect(services.maintenance.getMaintenanceMode).not.toHaveBeenCalled();
    expect(services.maintenance.createBackup).not.toHaveBeenCalled();
  });

  it.each([
    [{ backupPassword: "short", confirmBackupPassword: "short" }, "backupPassword"],
    [{ backupPassword: "portable-password", confirmBackupPassword: "different-password" }, "confirmBackupPassword"],
    [{ currentPassword: "" }, "currentPassword"],
    [{ unexpected: "field" }, "body"],
  ])("validates backup secrets before reauthentication or spool access", async (override, field) => {
    const services = servicesFor();
    getRuntimeServices.mockReturnValue(services);

    const response = await POST(backupRequest(override));

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ code: "VALIDATION_FAILED", requestId: REQUEST_ID });
    expect(body.fieldErrors).toHaveProperty(field);
    expect(services.auth.api.verifyPassword).not.toHaveBeenCalled();
    expect(services.maintenance.getMaintenanceMode).not.toHaveBeenCalled();
    expect(services.maintenance.createBackup).not.toHaveBeenCalled();
  });

  it("reauthenticates and queues one matching 12-character backup password", async () => {
    const services = servicesFor();
    getRuntimeServices.mockReturnValue(services);

    const response = await POST(backupRequest());

    expect(response.status).toBe(202);
    const responseBody = await response.json();
    expect(responseBody).toEqual({
      id: JOB_ID,
      type: "backup",
      state: "queued",
      requestId: REQUEST_ID,
    });
    expect(services.auth.api.verifyPassword).toHaveBeenCalledWith({
      body: { password: "current-password" },
      headers: expect.any(Headers),
    });
    expect(services.maintenance.createBackup).toHaveBeenCalledWith({
      actorId: ADMIN_ID,
      requestId: REQUEST_ID,
      passphrase: "portable-password",
    });
    expect(backupConsume).toHaveBeenCalledWith(ADMIN_ID);
    expect(JSON.stringify(responseBody)).not.toMatch(/current-password|portable-password/);
  });

  it("maps password failure and maintenance contention to stable public errors", async () => {
    const invalidPassword = servicesFor({
      verifyPassword: vi.fn().mockRejectedValue(new APIError("BAD_REQUEST")),
    });
    getRuntimeServices.mockReturnValueOnce(invalidPassword);
    const passwordResponse = await POST(backupRequest());
    expect(passwordResponse.status).toBe(401);
    await expect(passwordResponse.json()).resolves.toEqual({
      code: "CURRENT_PASSWORD_INVALID",
      message: "当前密码错误",
      requestId: REQUEST_ID,
    });
    expect(invalidPassword.maintenance.createBackup).not.toHaveBeenCalled();

    const busy = servicesFor({
      createBackup: vi.fn().mockRejectedValue(new ApiError(
        409,
        "MAINTENANCE_BUSY",
        "已有维护任务正在执行",
      )),
    });
    getRuntimeServices.mockReturnValueOnce(busy);
    const busyResponse = await POST(backupRequest());
    expect(busyResponse.status).toBe(409);
    await expect(busyResponse.json()).resolves.toEqual({
      code: "MAINTENANCE_BUSY",
      message: "已有维护任务正在执行",
      requestId: REQUEST_ID,
    });
  });

  it("returns safe 503 without queuing work while production maintenance is active", async () => {
    const services = servicesFor({ maintenanceActive: true });
    getRuntimeServices.mockReturnValue(services);

    const response = await POST(backupRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({
      code: "MAINTENANCE_ACTIVE",
      requestId: REQUEST_ID,
    });
    expect(services.maintenance.createBackup).not.toHaveBeenCalled();
  });

  it("uses an independent creation throttle", async () => {
    const services = servicesFor();
    getRuntimeServices.mockReturnValue(services);
    backupConsume
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试", undefined, {
          "retry-after": "60",
        });
      });

    for (let index = 0; index < 3; index += 1) {
      expect((await POST(backupRequest(undefined, {}, `rate-backup-${index}`))).status).toBe(202);
    }
    const response = await POST(backupRequest(undefined, {}, "rate-backup-final"));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    await expect(response.json()).resolves.toMatchObject({ code: "RATE_LIMITED" });
    expect(services.maintenance.createBackup).toHaveBeenCalledTimes(3);
  });

  it("lists at most five successful backups in newest-first order", async () => {
    const backups = Array.from({ length: 6 }, (_, index) => ({
      id: `backup-${index}`,
      createdAt: `2026-09-0${index + 1}T07:00:00.000Z`,
      size: index + 1,
      sha256: String(index).repeat(64),
    }));
    const services = servicesFor({ backups });
    getRuntimeServices.mockReturnValue(services);

    const response = await GET(adminGetRequest("/backups"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({ items: backups.slice().reverse().slice(0, 5) });
  });
});

describe("GET /api/v1/admin/maintenance/jobs/{jobId}", () => {
  it("keeps job status readable during maintenance and returns only public status", async () => {
    const getJob = vi.fn().mockResolvedValue({
      id: JOB_ID,
      type: "restore",
      state: "restoring",
      requestId: "restore-request",
      updatedAt: "2026-09-03T07:00:00.000Z",
    });
    const services = servicesFor({ maintenanceActive: true, getJob });
    getRuntimeServices.mockReturnValue(services);

    const response = await jobRoute.GET(
      adminGetRequest(`/maintenance/jobs/${JOB_ID}`),
      { params: Promise.resolve({ jobId: JOB_ID }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      id: JOB_ID,
      type: "restore",
      state: "restoring",
      requestId: "restore-request",
      updatedAt: "2026-09-03T07:00:00.000Z",
    });
    expect(services.maintenance.getMaintenanceMode).not.toHaveBeenCalled();
    expect(statusConsume).toHaveBeenCalledWith(ADMIN_ID);
  });

  it("redacts malformed disk-state failures to a stable code and request ID", async () => {
    const getJob = vi.fn().mockRejectedValue(new ApiError(
      500,
      "MAINTENANCE_STATE_INVALID",
      "维护状态暂时不可用",
    ));
    getRuntimeServices.mockReturnValue(servicesFor({ getJob }));

    const response = await jobRoute.GET(
      adminGetRequest(`/maintenance/jobs/${JOB_ID}`),
      { params: Promise.resolve({ jobId: JOB_ID }) },
    );
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(serialized).toContain("MAINTENANCE_STATE_INVALID");
    expect(serialized).toContain(REQUEST_ID);
    expect(serialized).not.toMatch(/\/var\/lib|postgresql:|pg_restore|portable-password/);
  });
});

function sessionUser(role: "member" | "admin", status: "active" | "disabled") {
  return {
    user: {
      id: ADMIN_ID,
      name: "administrator",
      username: "administrator",
      role,
      status,
    },
  };
}

function servicesFor({
  session = sessionUser("admin", "active"),
  verifyPassword = vi.fn().mockResolvedValue({ status: true }),
  createBackup = vi.fn().mockResolvedValue({
    id: JOB_ID,
    type: "backup",
    state: "queued",
    requestId: REQUEST_ID,
  }),
  maintenanceActive = false,
  backups = [],
  getJob = vi.fn(),
}: {
  session?: unknown;
  verifyPassword?: ReturnType<typeof vi.fn>;
  createBackup?: ReturnType<typeof vi.fn>;
  maintenanceActive?: boolean;
  backups?: unknown[];
  getJob?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    auth: {
      api: {
        getSession: vi.fn().mockResolvedValue(session),
        verifyPassword,
      },
    },
    maintenance: {
      getMaintenanceMode: vi.fn().mockResolvedValue(maintenanceActive ? {
        active: true,
        jobId: JOB_ID,
        updatedAt: "2026-09-03T07:00:00.000Z",
      } : null),
      createBackup,
      listBackups: vi.fn().mockResolvedValue(backups),
      getJob,
    },
  };
}

function backupRequest(
  override: Record<string, unknown> = {},
  headerOverride: Record<string, string> = {},
  requestSuffix = "default",
): Request {
  return new Request(`https://fitgrid.example/api/v1/admin/backups?request=${requestSuffix}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "fitgrid.example",
      Origin: "https://fitgrid.example",
      "X-Request-Id": REQUEST_ID,
      ...headerOverride,
    },
    body: JSON.stringify({
      currentPassword: "current-password",
      backupPassword: "portable-password",
      confirmBackupPassword: "portable-password",
      ...override,
    }),
  });
}

function adminGetRequest(path: string): Request {
  return new Request(`https://fitgrid.example/api/v1/admin${path}`, {
    headers: {
      Host: "fitgrid.example",
      Origin: "https://fitgrid.example",
      "X-Request-Id": REQUEST_ID,
    },
  });
}
