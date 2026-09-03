import { ApiError } from "@/server/http/api-error";
import { requireAdmin } from "@/server/auth/session";
import { json } from "@/server/http/route-factory";
import {
  assertMaintenanceAvailable,
  assertMaintenanceSameOrigin,
  maintenanceApiHandler,
} from "@/server/maintenance/http";
import { portableBackupFilenameSchema } from "@/server/maintenance/types";
import { getRuntimeServices } from "@/server/runtime/services";
import { restoreInspectionRequests } from "@/server/security/request-protection";

const mediaType = "application/vnd.fitgrid.backup";
const defaultMaxUploadBytes = 536_870_912;

function uploadLimit(): number {
  const value = process.env.PORTABLE_BACKUP_MAX_BYTES;
  if (value === undefined) return defaultMaxUploadBytes;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("Maintenance upload configuration is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Maintenance upload configuration is invalid");
  return parsed;
}

function declaredSize(request: Request, maximum: number): number {
  const value = request.headers.get("x-fitgrid-backup-size") ?? "";
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ApiError(422, "BACKUP_SIZE_INVALID", "备份大小无效");
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size)) {
    throw new ApiError(422, "BACKUP_SIZE_INVALID", "备份大小无效");
  }
  if (size > maximum) {
    throw new ApiError(413, "BACKUP_TOO_LARGE", "备份文件超过大小限制");
  }
  return size;
}

function passphrase(request: Request): string {
  const value = request.headers.get("x-fitgrid-backup-passphrase") ?? "";
  const length = Array.from(value).length;
  if (length < 12 || length > 128 || /[\n\r\0]/.test(value)) {
    throw new ApiError(422, "BACKUP_PASSPHRASE_INVALID", "备份密码必须包含 12–128 个字符");
  }
  return value;
}

function fileName(request: Request): string {
  const values = new URL(request.url).searchParams.getAll("fileName");
  if (values.length !== 1 || !portableBackupFilenameSchema.safeParse(values[0]).success) {
    throw new ApiError(422, "BACKUP_FILENAME_INVALID", "备份文件名无效");
  }
  return values[0];
}

export async function POST(request: Request): Promise<Response> {
  return maintenanceApiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const admin = await requireAdmin(request.headers, services.auth);
    assertMaintenanceSameOrigin(request);
    restoreInspectionRequests.consume(admin.id);

    if (request.headers.get("content-type")?.toLowerCase() !== mediaType) {
      throw new ApiError(415, "BACKUP_MEDIA_TYPE_INVALID", `备份上传必须使用 ${mediaType}`);
    }
    const name = fileName(request);
    const size = declaredSize(request, uploadLimit());
    const secret = passphrase(request);
    if (!request.body) throw new ApiError(422, "BACKUP_BODY_REQUIRED", "缺少备份上传内容");
    assertMaintenanceAvailable(await services.maintenance.getMaintenanceMode());

    return json(await services.maintenance.writeUpload({
      actorId: admin.id,
      requestId,
      passphrase: secret,
      fileName: name,
      size,
    }, request.body), 202, requestId);
  });
}
