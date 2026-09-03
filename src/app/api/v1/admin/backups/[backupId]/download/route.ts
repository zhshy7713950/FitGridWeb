import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { ApiError } from "@/server/http/api-error";
import { requireAdmin } from "@/server/auth/session";
import {
  assertMaintenanceAvailable,
  backupNotFound,
  maintenanceApiHandler,
  requireBackupArtifact,
} from "@/server/maintenance/http";
import { portableBackupIdSchema } from "@/server/maintenance/types";
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

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return maintenanceApiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const admin = await requireAdmin(request.headers, services.auth);
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

    return new Response(Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>, {
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
  });
}
