import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getRuntimeServices, requireAdmin } = vi.hoisted(() => ({
  getRuntimeServices: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock("@/server/runtime/services", () => ({ getRuntimeServices }));
vi.mock("@/server/auth/session", () => ({ requireAdmin }));

import * as adminInvitations from "@/app/api/v1/admin/invitations/route";
import * as adminBackupDownload from "@/app/api/v1/admin/backups/[backupId]/download/route";
import * as adminBackupDownloadToken from "@/app/api/v1/admin/backups/[backupId]/download-token/route";
import * as adminBackups from "@/app/api/v1/admin/backups/route";
import * as adminMaintenanceJob from "@/app/api/v1/admin/maintenance/jobs/[jobId]/route";
import * as adminRestoreConfirm from "@/app/api/v1/admin/restores/[restoreId]/confirm/route";
import * as adminRestoreUpload from "@/app/api/v1/admin/restores/uploads/route";
import * as adminUserStatus from "@/app/api/v1/admin/users/[userId]/status/route";
import * as adminUsers from "@/app/api/v1/admin/users/route";
import * as changePassword from "@/app/api/v1/auth/change-password/route";
import * as login from "@/app/api/v1/auth/login/route";
import * as logout from "@/app/api/v1/auth/logout/route";
import * as session from "@/app/api/v1/auth/session/route";
import * as gridTradeRecalculate from "@/app/api/v1/grid-trades/[id]/recalculate/route";
import * as gridTrade from "@/app/api/v1/grid-trades/[id]/route";
import * as gridExport from "@/app/api/v1/grid-trades/export/route";
import * as gridImportCommit from "@/app/api/v1/grid-trades/import/commit/route";
import * as gridImportPreview from "@/app/api/v1/grid-trades/import/preview/route";
import * as gridTrades from "@/app/api/v1/grid-trades/route";
import * as health from "@/app/api/v1/health/route";
import * as invitationAccept from "@/app/api/v1/invitations/[token]/accept/route";
import * as invitation from "@/app/api/v1/invitations/[token]/route";

type RouteModule = Record<string, unknown>;

const routes: Record<string, RouteModule> = {
  "/health": health,
  "/auth/login": login,
  "/auth/logout": logout,
  "/auth/session": session,
  "/auth/change-password": changePassword,
  "/invitations/{token}": invitation,
  "/invitations/{token}/accept": invitationAccept,
  "/admin/invitations": adminInvitations,
  "/admin/backups": adminBackups,
  "/admin/backups/{backupId}/download-token": adminBackupDownloadToken,
  "/admin/backups/{backupId}/download": adminBackupDownload,
  "/admin/restores/uploads": adminRestoreUpload,
  "/admin/restores/{restoreId}/confirm": adminRestoreConfirm,
  "/admin/maintenance/jobs/{jobId}": adminMaintenanceJob,
  "/admin/users": adminUsers,
  "/admin/users/{userId}/status": adminUserStatus,
  "/grid-trades": gridTrades,
  "/grid-trades/{id}": gridTrade,
  "/grid-trades/{id}/recalculate": gridTradeRecalculate,
  "/grid-trades/import/preview": gridImportPreview,
  "/grid-trades/import/commit": gridImportCommit,
  "/grid-trades/export": gridExport,
};

describe("OpenAPI route coverage", () => {
  afterEach(() => {
    delete process.env.APP_BASE_PATH;
    delete process.env.BETTER_AUTH_URL;
    getRuntimeServices.mockReset();
    requireAdmin.mockReset();
  });

  it("has a callable Route Handler for every documented operation", async () => {
    const source = await readFile(
      path.join(process.cwd(), "docs/fit-replication/contracts/openapi.yaml"),
      "utf8",
    );
    const document = parse(source) as {
      openapi: string;
      paths: Record<string, Record<string, { operationId?: string }>>;
    };

    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(routes).sort()).toEqual(Object.keys(document.paths).sort());

    for (const [apiPath, pathItem] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!operation.operationId) continue;
        expect(routes[apiPath]?.[method.toUpperCase()], operation.operationId).toBeTypeOf("function");
      }
    }
  });

  it("documents unusable import previews and commit rate limits", async () => {
    const source = await readFile(
      path.join(process.cwd(), "docs/fit-replication/contracts/openapi.yaml"),
      "utf8",
    );
    const document = parse(source) as {
      paths: Record<string, Record<string, {
        responses?: Record<string, { $ref?: string; description?: string }>;
      }>>;
    };
    const responses = document.paths["/grid-trades/import/commit"]?.post?.responses;

    expect(responses?.["404"]).toMatchObject({
      $ref: "#/components/responses/NotFound",
      description: expect.stringContaining("IMPORT_PREVIEW_NOT_FOUND"),
    });
    expect(responses?.["429"]).toEqual({
      $ref: "#/components/responses/RateLimited",
    });
  });

  it("documents administrator mutation conflicts, validation, and rate limits", async () => {
    const source = await readFile(
      path.join(process.cwd(), "docs/fit-replication/contracts/openapi.yaml"),
      "utf8",
    );
    const document = parse(source) as {
      paths: Record<string, Record<string, {
        responses?: Record<string, { $ref?: string }>;
      }>>;
    };

    expect(document.paths["/admin/invitations"]?.post?.responses?.["429"]).toEqual({
      $ref: "#/components/responses/RateLimited",
    });
    expect(document.paths["/admin/users/{userId}/status"]?.patch?.responses).toMatchObject({
      "409": { $ref: "#/components/responses/Conflict" },
      "422": { $ref: "#/components/responses/ValidationError" },
      "429": { $ref: "#/components/responses/RateLimited" },
    });
  });

  it("documents the complete administrator maintenance contract", async () => {
    const source = await readFile(
      path.join(process.cwd(), "docs/fit-replication/contracts/openapi.yaml"),
      "utf8",
    );
    const document = parse(source) as {
      paths: Record<string, Record<string, {
        responses?: Record<string, { $ref?: string; headers?: Record<string, unknown> }>;
        requestBody?: { content?: Record<string, unknown> };
        parameters?: Array<{
          name?: string;
          description?: string;
          schema?: { default?: number; maximum?: number };
        }>;
      }>>;
      components: { schemas: Record<string, { required?: string[]; enum?: string[] }> };
    };

    expect(document.paths["/admin/backups"]?.post?.responses).toMatchObject({
      "202": expect.any(Object),
      "401": { $ref: "#/components/responses/Unauthorized" },
      "403": { $ref: "#/components/responses/Forbidden" },
      "409": { $ref: "#/components/responses/Conflict" },
      "422": { $ref: "#/components/responses/ValidationError" },
      "429": { $ref: "#/components/responses/RateLimited" },
      "500": { $ref: "#/components/responses/InternalError" },
      "503": { $ref: "#/components/responses/ServiceUnavailable" },
    });
    expect(document.paths["/admin/restores/uploads"]?.post?.requestBody?.content)
      .toHaveProperty("application/vnd.fitgrid.backup");
    const declaredSize = document.paths["/admin/restores/uploads"]?.post?.parameters
      ?.find((parameter) => parameter.name === "X-FitGrid-Backup-Size");
    expect(declaredSize).toMatchObject({
      description: expect.stringContaining("部署"),
      schema: { default: 536_870_912 },
    });
    expect(declaredSize?.schema?.maximum).toBeUndefined();
    expect(document.paths["/admin/restores/uploads"]?.post?.responses).toMatchObject({
      "413": expect.any(Object),
      "415": expect.any(Object),
    });
    expect(document.paths["/admin/backups/{backupId}/download"]?.get?.responses?.["200"]?.headers)
      .toMatchObject({
        "Cache-Control": expect.any(Object),
        "Content-Disposition": expect.any(Object),
        "X-Content-Type-Options": expect.any(Object),
      });
    expect(document.components.schemas.MaintenanceState.enum).toEqual([
      "queued", "dumping", "encrypting", "ready", "uploading", "inspecting",
      "awaiting-confirmation", "snapshotting", "restoring", "migrating", "checking",
      "succeeded", "failed", "rollback", "intervention-required",
    ]);
    expect(document.components.schemas.PortableBackupSummary.required)
      .toEqual(["id", "createdAt", "size", "sha256"]);
    expect(document.components.schemas.RestorePreview.required)
      .toEqual(["users", "gridTrades", "invitations", "importPreviews"]);
    expect(document.components.schemas.MaintenanceJobStatus.required)
      .toEqual(["id", "type", "state", "requestId", "updatedAt"]);
  });

  it("documents password mutation throttling and malformed invitation tokens", async () => {
    const source = await readFile(
      path.join(process.cwd(), "docs/fit-replication/contracts/openapi.yaml"),
      "utf8",
    );
    const document = parse(source) as {
      paths: Record<string, Record<string, {
        responses?: Record<string, { $ref?: string }>;
      }>>;
    };

    expect(document.paths["/auth/change-password"]?.post?.responses?.["429"]).toEqual({
      $ref: "#/components/responses/RateLimited",
    });
    expect(document.paths["/invitations/{token}"]?.get?.responses?.["422"]).toEqual({
      $ref: "#/components/responses/ValidationError",
    });
  });

  it("requires both fields in the invitation status response contract", async () => {
    const source = await readFile(
      path.join(process.cwd(), "docs/fit-replication/contracts/openapi.yaml"),
      "utf8",
    );
    const document = parse(source) as {
      components: { schemas: { InvitationStatusResponse: { required?: string[] } } };
    };

    expect(document.components.schemas.InvitationStatusResponse.required)
      .toEqual(["status", "expiresAt"]);
  });

  it.each([
    [undefined, "https://fitgrid.example", "https://fitgrid.example/invite/route-contract-token-000000000001"],
    ["/fitgrid", "https://fitgrid.example/fitgrid", "https://fitgrid.example/fitgrid/invite/route-contract-token-000000000001"],
  ])("creates a public invitation URL beneath APP_BASE_PATH=%s", async (basePath, publicUrl, expected) => {
    if (basePath) process.env.APP_BASE_PATH = basePath;
    process.env.BETTER_AUTH_URL = publicUrl;
    requireAdmin.mockResolvedValue({ id: "admin-1" });
    getRuntimeServices.mockReturnValue({
      invitations: {
        create: vi.fn().mockResolvedValue({
          id: "00000000-0000-4000-8000-000000000001",
          token: "route-contract-token-000000000001",
          expiresAt: "2026-09-03T00:00:00.000Z",
        }),
      },
    });

    const response = await adminInvitations.POST(new Request(
      "http://0.0.0.0:3000/api/v1/admin/invitations?untrusted=/elsewhere",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "0.0.0.0:3000",
          Origin: "http://0.0.0.0:3000",
        },
        body: JSON.stringify({ expiresInHours: 24 }),
      },
    ));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ inviteUrl: expected });
  });

  it.each([undefined, "", "not-a-url", "http://fitgrid.example/fitgrid"])(
    "refuses BETTER_AUTH_URL=%s before persisting an invitation",
    async (publicUrl) => {
      if (publicUrl === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = publicUrl;
      process.env.APP_BASE_PATH = "/fitgrid";
      requireAdmin.mockResolvedValue({ id: `admin-invalid-url-${String(publicUrl)}` });
      const create = vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000002",
        token: "route-contract-token-000000000002",
        expiresAt: "2026-09-03T00:00:00.000Z",
      });
      getRuntimeServices.mockReturnValue({ invitations: { create } });

      const response = await adminInvitations.POST(new Request(
        "http://0.0.0.0:3000/api/v1/admin/invitations",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Host: "0.0.0.0:3000",
            Origin: "http://0.0.0.0:3000",
          },
          body: JSON.stringify({ expiresInHours: 24 }),
        },
      ));

      expect(response.status).toBe(500);
      expect(create).not.toHaveBeenCalled();
    },
  );
});
