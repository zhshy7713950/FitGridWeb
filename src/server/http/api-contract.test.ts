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
    [undefined, "https://fitgrid.example/invite/route-contract-token-000000000001"],
    ["/fitgrid", "https://fitgrid.example/fitgrid/invite/route-contract-token-000000000001"],
  ])("creates a public invitation URL beneath APP_BASE_PATH=%s", async (basePath, expected) => {
    if (basePath) process.env.APP_BASE_PATH = basePath;
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
      "https://fitgrid.example/api/v1/admin/invitations?untrusted=/elsewhere",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "fitgrid.example",
          Origin: "https://fitgrid.example",
        },
        body: JSON.stringify({ expiresInHours: 24 }),
      },
    ));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ inviteUrl: expected });
  });
});
