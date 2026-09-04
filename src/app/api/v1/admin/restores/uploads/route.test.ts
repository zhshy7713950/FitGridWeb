import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/server/http/api-error";

const { getRuntimeServices, inspectionConsume } = vi.hoisted(() => ({
  getRuntimeServices: vi.fn(),
  inspectionConsume: vi.fn(),
}));
vi.mock("@/server/runtime/services", () => ({ getRuntimeServices }));
vi.mock("@/server/security/request-protection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/security/request-protection")>();
  return { ...actual, restoreInspectionRequests: { consume: inspectionConsume } };
});

import { POST } from "./route";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "request_restore_upload_0001";
const FILE_NAME = "fitgridweb-20260903T070000Z.fitgridbackup";

afterEach(() => {
  getRuntimeServices.mockReset();
  inspectionConsume.mockReset();
  delete process.env.PORTABLE_BACKUP_MAX_BYTES;
});

describe("POST /api/v1/admin/restores/uploads", () => {
  it("strictly decodes a UTF-8 base64url passphrase before writing the upload", async () => {
    const services = servicesFor();
    getRuntimeServices.mockReturnValue(services);
    const body = chunkedBody([new Uint8Array(3)]);
    const request = uploadRequest(body, {
      "X-FitGrid-Backup-Passphrase": "5Lit5paH5aSH5Lu95a-G56CB8J-UkOWuieWFqOaBouWkjeWNgeS6jA",
      "X-FitGrid-Backup-Passphrase-Encoding": "base64url-utf8",
    });

    const response = await POST(request);

    expect(response.status).toBe(202);
    expect(services.maintenance.writeUpload).toHaveBeenCalledWith(
      expect.objectContaining({ passphrase: "中文备份密码🔐安全恢复十二" }),
      body,
    );
  });

  it.each([
    ["missing encoding", "", "cG9ydGFibGUtcGFzc3dvcmQ"],
    ["unknown encoding", "base64", "cG9ydGFibGUtcGFzc3dvcmQ"],
    ["non-base64url alphabet", "base64url-utf8", "YWJjZGVmZ2hpamts+g"],
    ["impossible base64url length", "base64url-utf8", "aaaaaaaaaaaaa"],
    ["non-canonical base64url", "base64url-utf8", "YWJjZGVmZ2hpamtsZh"],
    ["invalid UTF-8", "base64url-utf8", "________________"],
    ["decoded NUL", "base64url-utf8", "YWJjZGVmZ2hpamtsAA"],
    ["decoded newline", "base64url-utf8", "YWJjZGVmZ2hpamtsCg"],
    ["decoded value below 12 code points", "base64url-utf8", "YWJjZGVmZ2hpams"],
    [
      "decoded value above 128 code points",
      "base64url-utf8",
      "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh",
    ],
  ])("rejects %s without reading the body", async (_label, encoding, encodedPassphrase) => {
    const services = servicesFor();
    getRuntimeServices.mockReturnValue(services);
    const body = observableBody();
    const response = await POST(uploadRequest(body, {
      "X-FitGrid-Backup-Passphrase": encodedPassphrase,
      "X-FitGrid-Backup-Passphrase-Encoding": encoding,
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "BACKUP_PASSPHRASE_INVALID",
      requestId: REQUEST_ID,
    });
    expect(body.readCount()).toBe(0);
    expect(services.maintenance.writeUpload).not.toHaveBeenCalled();
  });

  it("streams the raw body object directly to the maintenance gateway", async () => {
    const services = servicesFor();
    getRuntimeServices.mockReturnValue(services);
    const body = chunkedBody([new Uint8Array(64), new Uint8Array(64)]);
    const request = uploadRequest(body, { "X-FitGrid-Backup-Size": "128" });
    const formData = vi.spyOn(request, "formData").mockRejectedValue(new Error("must not buffer form data"));
    const arrayBuffer = vi.spyOn(request, "arrayBuffer").mockRejectedValue(new Error("must not buffer body"));

    const response = await POST(request);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      id: JOB_ID,
      type: "inspect-restore",
      state: "queued",
      requestId: REQUEST_ID,
    });
    expect(services.maintenance.writeUpload).toHaveBeenCalledWith({
      actorId: ADMIN_ID,
      requestId: REQUEST_ID,
      passphrase: "portable-password",
      fileName: FILE_NAME,
      size: 128,
    }, body);
    expect(inspectionConsume).toHaveBeenCalledWith(ADMIN_ID);
    expect(formData).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it.each([
    ["anonymous", null, 401],
    ["member", sessionFor("member", "active"), 403],
    ["disabled-admin", sessionFor("admin", "disabled"), 401],
  ])("rejects %s before reading the body or touching the spool", async (_label, session, status) => {
    const services = servicesFor({ session });
    getRuntimeServices.mockReturnValue(services);
    const body = observableBody();

    const response = await POST(uploadRequest(body));

    expect(response.status).toBe(status);
    expect(body.readCount()).toBe(0);
    expect(services.maintenance.getMaintenanceMode).not.toHaveBeenCalled();
    expect(services.maintenance.writeUpload).not.toHaveBeenCalled();
  });

  it.each([
    [{ "Content-Type": "application/octet-stream" }, undefined, 415, "BACKUP_MEDIA_TYPE_INVALID"],
    [{ "Content-Type": "application/vnd.fitgrid.backup; charset=utf-8" }, undefined, 415, "BACKUP_MEDIA_TYPE_INVALID"],
    [{ "X-FitGrid-Backup-Size": "" }, undefined, 422, "BACKUP_SIZE_INVALID"],
    [{ "X-FitGrid-Backup-Size": "0" }, undefined, 422, "BACKUP_SIZE_INVALID"],
    [{ "X-FitGrid-Backup-Size": "12.5" }, undefined, 422, "BACKUP_SIZE_INVALID"],
    [{ "X-FitGrid-Backup-Passphrase": "short" }, undefined, 422, "BACKUP_PASSPHRASE_INVALID"],
    [{}, "backup.tar", 422, "BACKUP_FILENAME_INVALID"],
  ])("rejects cheap invalid headers before pulling the body", async (headers, fileName, status, code) => {
    const services = servicesFor();
    getRuntimeServices.mockReturnValue(services);
    const body = observableBody();

    const response = await POST(uploadRequest(body, headers, fileName));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ code, requestId: REQUEST_ID });
    expect(body.readCount()).toBe(0);
    expect(services.maintenance.getMaintenanceMode).not.toHaveBeenCalled();
    expect(services.maintenance.writeUpload).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared size before pulling the body", async () => {
    process.env.PORTABLE_BACKUP_MAX_BYTES = "128";
    const services = servicesFor();
    getRuntimeServices.mockReturnValue(services);
    const body = observableBody();

    const response = await POST(uploadRequest(body, { "X-FitGrid-Backup-Size": "129" }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "BACKUP_TOO_LARGE" });
    expect(body.readCount()).toBe(0);
    expect(services.maintenance.writeUpload).not.toHaveBeenCalled();
  });

  it("returns safe 503 before pulling the body while production maintenance is active", async () => {
    const services = servicesFor({ maintenanceActive: true });
    getRuntimeServices.mockReturnValue(services);
    const body = observableBody();

    const response = await POST(uploadRequest(body));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(body.readCount()).toBe(0);
    expect(services.maintenance.writeUpload).not.toHaveBeenCalled();
  });

  it.each([
    new ApiError(422, "BACKUP_SIZE_MISMATCH", "备份实际大小与声明不一致"),
    new ApiError(413, "BACKUP_TOO_LARGE", "备份文件超过大小限制"),
    new Error("socket closed: /var/lib/private-host/database.dump portable-password"),
  ])("maps counted-stream failures without leaking request secrets", async (error) => {
    const services = servicesFor({ writeUpload: vi.fn().mockRejectedValue(error) });
    getRuntimeServices.mockReturnValue(services);
    const response = await POST(uploadRequest(chunkedBody([new Uint8Array(3)]), {
      "X-FitGrid-Backup-Size": "3",
    }));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(error instanceof ApiError ? error.status : 500);
    expect(serialized).toContain(REQUEST_ID);
    expect(serialized).not.toMatch(/portable-password|\/var\/lib|database\.dump|socket closed/);
  });
});

function servicesFor({
  session = sessionFor("admin", "active"),
  maintenanceActive = false,
  writeUpload = vi.fn().mockResolvedValue({
    id: JOB_ID,
    type: "inspect-restore",
    state: "queued",
    requestId: REQUEST_ID,
  }),
}: {
  session?: unknown;
  maintenanceActive?: boolean;
  writeUpload?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    auth: { api: { getSession: vi.fn().mockResolvedValue(session) } },
    maintenance: {
      getMaintenanceMode: vi.fn().mockResolvedValue(maintenanceActive ? {
        active: true,
        jobId: JOB_ID,
        updatedAt: "2026-09-03T07:00:00.000Z",
      } : null),
      writeUpload,
    },
  };
}

function sessionFor(role: "member" | "admin", status: "active" | "disabled") {
  return { user: { id: ADMIN_ID, name: "admin", username: "admin", role, status } };
}

function uploadRequest(
  body: ReadableStream<Uint8Array>,
  overrides: Record<string, string> = {},
  fileName = FILE_NAME,
): Request {
  return new Request(
    `https://fitgrid.example/api/v1/admin/restores/uploads?fileName=${encodeURIComponent(fileName)}`,
    {
      method: "POST",
      headers: {
        Host: "fitgrid.example",
        Origin: "https://fitgrid.example",
        "Content-Type": "application/vnd.fitgrid.backup",
        "X-FitGrid-Backup-Passphrase": "cG9ydGFibGUtcGFzc3dvcmQ",
        "X-FitGrid-Backup-Passphrase-Encoding": "base64url-utf8",
        "X-FitGrid-Backup-Size": "3",
        "X-Request-Id": REQUEST_ID,
        ...overrides,
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" },
  );
}

function chunkedBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function observableBody(): ReadableStream<Uint8Array> & { readCount(): number } {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  const originalGetReader = body.getReader.bind(body);
  body.getReader = ((...arguments_: Parameters<typeof body.getReader>) => {
    reads += 1;
    return originalGetReader(...arguments_);
  }) as typeof body.getReader;
  return Object.assign(body, { readCount: () => reads });
}
