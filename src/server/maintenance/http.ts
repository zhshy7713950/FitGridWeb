import { ApiError } from "@/server/http/api-error";
import { apiHandler, type ApiContext } from "@/server/http/route-factory";

import type { MaintenanceMode } from "./types";

const privateResponseHeaders = {
  "Cache-Control": "no-store, private",
  "X-Content-Type-Options": "nosniff",
} as const;

export async function maintenanceApiHandler(
  request: Request,
  handler: (context: ApiContext) => Response | Promise<Response>,
): Promise<Response> {
  const response = await apiHandler(request, handler);
  for (const [name, value] of Object.entries(privateResponseHeaders)) {
    response.headers.set(name, value);
  }
  return response;
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
