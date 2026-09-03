import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/server/http/api-error";

const { confirmConsume, getRuntimeServices } = vi.hoisted(() => ({
  confirmConsume: vi.fn(),
  getRuntimeServices: vi.fn(),
}));
vi.mock("@/server/runtime/services", () => ({ getRuntimeServices }));
vi.mock("@/server/security/request-protection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/security/request-protection")>();
  return { ...actual, restoreConfirmationRequests: { consume: confirmConsume } };
});

import { POST } from "./route";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const RESTORE_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "request_restore_confirm_0001";

afterEach(() => {
  getRuntimeServices.mockReset();
  confirmConsume.mockReset();
});

describe("POST /api/v1/admin/restores/{restoreId}/confirm", () => {
  it.each([
    ["anonymous", null, 401],
    ["member", sessionFor("member", "active"), 403],
    ["disabled-admin", sessionFor("admin", "disabled"), 401],
  ])("rejects %s before reading a challenge or writing a restore job", async (_label, session, status) => {
    const services = servicesFor({ session });
    getRuntimeServices.mockReturnValue(services);

    const response = await POST(confirmRequest(), params());

    expect(response.status).toBe(status);
    expect(services.maintenance.getMaintenanceMode).not.toHaveBeenCalled();
    expect(services.maintenance.getJob).not.toHaveBeenCalled();
    expect(services.maintenance.confirmRestore).not.toHaveBeenCalled();
  });

  it.each([
    ["", "恢复全部数据", "currentPassword"],
    ["current-password", "恢复数据", "confirmationPhrase"],
    ["current-password", "恢复全部数据 ", "confirmationPhrase"],
  ])("requires a current password and the exact destructive phrase", async (
    currentPassword,
    confirmationPhrase,
    field,
  ) => {
    const services = servicesFor();
    getRuntimeServices.mockReturnValue(services);

    const response = await POST(confirmRequest({ currentPassword, confirmationPhrase }), params());

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.fieldErrors).toHaveProperty(field);
    expect(services.maintenance.getJob).not.toHaveBeenCalled();
    expect(services.auth.api.verifyPassword).not.toHaveBeenCalled();
    expect(services.maintenance.confirmRestore).not.toHaveBeenCalled();
  });

  it("resolves an unexpired challenge, reauthenticates, then queues the bound restore", async () => {
    const order: string[] = [];
    const getJob = vi.fn().mockImplementation(async () => {
      order.push("challenge");
      return awaitingStatus();
    });
    const verifyPassword = vi.fn().mockImplementation(async () => {
      order.push("reauthenticate");
      return { status: true };
    });
    const confirmRestore = vi.fn().mockImplementation(async () => {
      order.push("confirm");
      return { id: JOB_ID, type: "restore", state: "queued", requestId: REQUEST_ID };
    });
    const services = servicesFor({ getJob, verifyPassword, confirmRestore });
    getRuntimeServices.mockReturnValue(services);

    const response = await POST(confirmRequest(), params());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      id: JOB_ID,
      type: "restore",
      state: "queued",
      requestId: REQUEST_ID,
    });
    expect(order).toEqual(["challenge", "reauthenticate", "confirm"]);
    expect(confirmRestore).toHaveBeenCalledWith({
      actorId: ADMIN_ID,
      requestId: REQUEST_ID,
      restoreId: RESTORE_ID,
    });
    expect(confirmConsume).toHaveBeenCalledWith(ADMIN_ID);
  });

  it.each([
    ["expired", awaitingStatus({ expiresAt: 1 })],
    ["terminal", awaitingStatus({ state: "failed" })],
    ["wrong operation", awaitingStatus({ type: "backup" })],
    ["mismatched identifier", awaitingStatus({ id: JOB_ID })],
  ])("rejects an %s challenge before password verification", async (_label, status) => {
    const services = servicesFor({ getJob: vi.fn().mockResolvedValue(status) });
    getRuntimeServices.mockReturnValue(services);

    const response = await POST(confirmRequest(), params());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "MAINTENANCE_NOT_FOUND" });
    expect(services.auth.api.verifyPassword).not.toHaveBeenCalled();
    expect(services.maintenance.confirmRestore).not.toHaveBeenCalled();
  });

  it("does not queue when reauthentication fails or gateway binding rejects the actor", async () => {
    const invalidPassword = servicesFor({
      verifyPassword: vi.fn().mockRejectedValue(new APIError("BAD_REQUEST")),
    });
    getRuntimeServices.mockReturnValueOnce(invalidPassword);
    const invalidPasswordResponse = await POST(confirmRequest(), params());
    expect(invalidPasswordResponse.status).toBe(401);
    expect(invalidPassword.maintenance.confirmRestore).not.toHaveBeenCalled();

    const mismatch = servicesFor({
      confirmRestore: vi.fn().mockRejectedValue(new ApiError(
        404,
        "MAINTENANCE_NOT_FOUND",
        "维护任务或备份不存在",
      )),
    });
    getRuntimeServices.mockReturnValueOnce(mismatch);
    const mismatchResponse = await POST(confirmRequest(), params());
    expect(mismatchResponse.status).toBe(404);
    await expect(mismatchResponse.json()).resolves.toMatchObject({ code: "MAINTENANCE_NOT_FOUND" });
  });

  it("returns safe 503 before challenge resolution while maintenance is active", async () => {
    const services = servicesFor({ maintenanceActive: true });
    getRuntimeServices.mockReturnValue(services);

    const response = await POST(confirmRequest(), params());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(services.maintenance.getJob).not.toHaveBeenCalled();
    expect(services.maintenance.confirmRestore).not.toHaveBeenCalled();
  });
});

function awaitingStatus(overrides: Record<string, unknown> = {}) {
  return {
    id: RESTORE_ID,
    type: "inspect-restore",
    state: "awaiting-confirmation",
    requestId: "request_restore_inspect_0001",
    updatedAt: "2026-09-03T07:00:00.000Z",
    expiresAt: Math.floor(Date.now() / 1_000) + 600,
    backupCreatedAt: "2026-09-03T06:30:00.000Z",
    postgresMajor: 17,
    database: "fitgridweb",
    preview: { users: 2, gridTrades: 24, invitations: 1, importPreviews: 0 },
    ...overrides,
  };
}

function servicesFor({
  session = sessionFor("admin", "active"),
  maintenanceActive = false,
  getJob = vi.fn().mockResolvedValue(awaitingStatus()),
  verifyPassword = vi.fn().mockResolvedValue({ status: true }),
  confirmRestore = vi.fn().mockResolvedValue({
    id: JOB_ID,
    type: "restore",
    state: "queued",
    requestId: REQUEST_ID,
  }),
}: {
  session?: unknown;
  maintenanceActive?: boolean;
  getJob?: ReturnType<typeof vi.fn>;
  verifyPassword?: ReturnType<typeof vi.fn>;
  confirmRestore?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    auth: { api: { getSession: vi.fn().mockResolvedValue(session), verifyPassword } },
    maintenance: {
      getMaintenanceMode: vi.fn().mockResolvedValue(maintenanceActive ? {
        active: true,
        jobId: JOB_ID,
        updatedAt: "2026-09-03T07:00:00.000Z",
      } : null),
      getJob,
      confirmRestore,
    },
  };
}

function sessionFor(role: "member" | "admin", status: "active" | "disabled") {
  return { user: { id: ADMIN_ID, name: "admin", username: "admin", role, status } };
}

function confirmRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request(`https://fitgrid.example/api/v1/admin/restores/${RESTORE_ID}/confirm`, {
    method: "POST",
    headers: {
      Host: "fitgrid.example",
      Origin: "https://fitgrid.example",
      "Content-Type": "application/json",
      "X-Request-Id": REQUEST_ID,
    },
    body: JSON.stringify({
      currentPassword: "current-password",
      confirmationPhrase: "恢复全部数据",
      ...overrides,
    }),
  });
}

function params(restoreId = RESTORE_ID) {
  return { params: Promise.resolve({ restoreId }) };
}
