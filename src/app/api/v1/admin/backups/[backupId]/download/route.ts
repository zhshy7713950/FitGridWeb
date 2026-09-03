import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";

import { ApiError } from "@/server/http/api-error";
import { requireAdmin } from "@/server/auth/session";
import {
  assertMaintenanceAvailable,
  assertMaintenanceSameOrigin,
  backupNotFound,
  maintenanceApiHandler,
  requireBackupArtifact,
} from "@/server/maintenance/http";
import { portableBackupIdSchema } from "@/server/maintenance/types";
import type { PortableBackupFile } from "@/server/maintenance/types";
import { getRuntimeServices } from "@/server/runtime/services";

type RouteContext = { params: Promise<{ backupId: string }> };

function attachment(filename: string): string {
  return `attachment; filename="${filename}"`;
}

function downloadToken(request: Request): string {
  const values = new URL(request.url).searchParams.getAll("token");
  if (values.length !== 1 || values[0].length === 0 || values[0].length > 4_096) throw backupNotFound();
  return values[0];
}

function missingArchiveError(error: unknown): boolean {
  return ["ENOENT", "ELOOP", "ENOTDIR", "ESTALE"].includes(
    (error as NodeJS.ErrnoException).code ?? "",
  );
}

async function openValidatedArchive(file: PortableBackupFile) {
  let handle;
  try {
    handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (
      !info.isFile()
      || info.size !== file.size
      || info.dev !== file.dev
      || info.ino !== file.ino
    ) throw backupNotFound();
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof ApiError) throw error;
    if (missingArchiveError(error)) throw backupNotFound();
    throw error;
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return maintenanceApiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const admin = await requireAdmin(request.headers, services.auth);
    assertMaintenanceSameOrigin(request);
    if (request.headers.has("range")) {
      throw new ApiError(416, "RANGE_NOT_SUPPORTED", "备份下载不支持分段请求");
    }
    const parsed = portableBackupIdSchema.safeParse((await context.params).backupId);
    if (!parsed.success) throw backupNotFound();
    const backupId = parsed.data;
    const token = downloadToken(request);
    assertMaintenanceAvailable(await services.maintenance.getMaintenanceMode());
    const file = await requireBackupArtifact(() => services.maintenance.getBackupFile(backupId));
    await services.downloadTokens.consume(token, admin.id, backupId);
    const handle = await openValidatedArchive(file);
    const nodeStream = handle.createReadStream({ autoClose: true });

    try {
      return new Response(Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>, {
        status: 200,
        headers: {
          "Accept-Ranges": "none",
          "Cache-Control": "no-store, private",
          "Content-Disposition": attachment(file.name),
          "Content-Length": String(file.size),
          "Content-Type": "application/vnd.fitgrid.backup",
          "X-Content-Type-Options": "nosniff",
          "X-Request-Id": requestId,
        },
      });
    } catch (error) {
      nodeStream.destroy();
      throw error;
    }
  });
}
