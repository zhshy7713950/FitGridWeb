import { ApiError, toErrorResponse } from "@/server/http/api-error";
import { requestIdFromHeaders } from "@/server/http/request-context";
import type { ApiContext } from "@/server/http/route-factory";

import type { MaintenanceMode } from "./types";

const privateResponseHeaders = {
  "Cache-Control": "no-store, private",
  "X-Content-Type-Options": "nosniff",
} as const;

export async function maintenanceApiHandler(
  request: Request,
  handler: (context: ApiContext) => Response | Promise<Response>,
): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  let response: Response;
  try {
    if (new URL(request.url).searchParams.has("ownerId")) {
      throw new ApiError(422, "OWNER_FIELD_FORBIDDEN", "ownerId 只能从当前会话确定");
    }
    response = await handler({ requestId });
    response.headers.set("x-request-id", requestId);
  } catch (error) {
    response = toErrorResponse(error, requestId);
  }
  for (const [name, value] of Object.entries(privateResponseHeaders)) {
    response.headers.set(name, value);
  }
  return response;
}

function expectedOrigin(request: Request): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.slice(0, -1);
  if (!host || (protocol !== "http" && protocol !== "https")) {
    throw new ApiError(403, "CROSS_SITE_REQUEST", "拒绝跨站请求");
  }
  return `${protocol}://${host}`;
}

function assertOriginValue(value: string, expected: string): void {
  try {
    if (new URL(value).origin === expected) return;
  } catch {
    // Fall through to the single public cross-site error.
  }
  throw new ApiError(403, "CROSS_SITE_REQUEST", "拒绝跨站请求");
}

export function assertMaintenanceSameOrigin(request: Request): void {
  const expected = expectedOrigin(request);
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  let hasSameOriginEvidence = false;

  if (origin !== null) {
    assertOriginValue(origin, expected);
    hasSameOriginEvidence = true;
  }
  if (referer !== null) {
    assertOriginValue(referer, expected);
    hasSameOriginEvidence = true;
  }
  if (fetchSite !== undefined) {
    if (fetchSite === "same-origin") {
      hasSameOriginEvidence = true;
    } else if (
      fetchSite === "none"
      && request.headers.get("sec-fetch-mode")?.toLowerCase() === "navigate"
      && request.headers.get("sec-fetch-dest")?.toLowerCase() === "document"
    ) {
      hasSameOriginEvidence = true;
    } else {
      throw new ApiError(403, "CROSS_SITE_REQUEST", "拒绝跨站请求");
    }
  }
  if (!hasSameOriginEvidence) {
    throw new ApiError(403, "CROSS_SITE_REQUEST", "拒绝跨站请求");
  }
}

export function assertMaintenanceAvailable(mode: MaintenanceMode | null): void {
  if (!mode?.active) return;
  throw new ApiError(
    503,
    "MAINTENANCE_ACTIVE",
    "服务器正在执行数据维护",
    undefined,
    { "retry-after": "5" },
  );
}

export function maintenanceNotFound(): ApiError {
  return new ApiError(404, "MAINTENANCE_NOT_FOUND", "维护任务或备份不存在");
}

export function backupNotFound(): ApiError {
  return new ApiError(404, "BACKUP_NOT_FOUND", "备份不存在或下载链接已失效");
}

export async function requireBackupArtifact<T>(resolve: () => Promise<T>): Promise<T> {
  try {
    return await resolve();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) throw backupNotFound();
    throw error;
  }
}
