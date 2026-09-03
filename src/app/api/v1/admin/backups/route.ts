import { z } from "zod";

import { requireAdmin } from "@/server/auth/session";
import { json, parseJsonBody } from "@/server/http/route-factory";
import { reauthenticateAdmin } from "@/server/maintenance/admin-reauthentication";
import {
  assertMaintenanceAvailable,
  assertMaintenanceSameOrigin,
  maintenanceApiHandler,
} from "@/server/maintenance/http";
import { getRuntimeServices } from "@/server/runtime/services";
import { backupCreationRequests } from "@/server/security/request-protection";

const passphraseSchema = z.string().superRefine((value, context) => {
  const length = Array.from(value).length;
  if (length < 12 || length > 128 || /[\n\r\0]/.test(value)) {
    context.addIssue({ code: "custom", message: "备份密码必须包含 12–128 个字符" });
  }
});

const bodySchema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  backupPassword: passphraseSchema,
  confirmBackupPassword: z.string(),
}).superRefine((value, context) => {
  if (value.backupPassword !== value.confirmBackupPassword) {
    context.addIssue({
      code: "custom",
      path: ["confirmBackupPassword"],
      message: "两次输入的备份密码不一致",
    });
  }
});

export async function POST(request: Request): Promise<Response> {
  return maintenanceApiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const admin = await requireAdmin(request.headers, services.auth);
    assertMaintenanceSameOrigin(request);
    backupCreationRequests.consume(admin.id);
    const body = bodySchema.parse(await parseJsonBody(request));
    assertMaintenanceAvailable(await services.maintenance.getMaintenanceMode());
    await reauthenticateAdmin(services.auth, request.headers, body.currentPassword);
    return json(await services.maintenance.createBackup({
      actorId: admin.id,
      requestId,
      passphrase: body.backupPassword,
    }), 202, requestId);
  });
}

export async function GET(request: Request): Promise<Response> {
  return maintenanceApiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    await requireAdmin(request.headers, services.auth);
    assertMaintenanceSameOrigin(request);
    assertMaintenanceAvailable(await services.maintenance.getMaintenanceMode());
    const items = (await services.maintenance.listBackups())
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 5);
    return json({ items }, 200, requestId);
  });
}
