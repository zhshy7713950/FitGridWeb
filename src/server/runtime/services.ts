import { AdminService, PrismaAdminRepository } from "@/server/admin/admin-service";
import { getAuth } from "@/server/auth/auth";
import { getPrismaClient } from "@/server/db/client";
import { GridService, type OwnerScope } from "@/server/grid-application/grid-service";
import { withOwnerScope } from "@/server/grid-persistence/prisma-grid-trade-store";
import { ExportService } from "@/server/import-export/export-service";
import { ImportService } from "@/server/import-export/import-service";
import { PrismaImportRepository } from "@/server/import-export/prisma-import-repository";
import { DownloadTokenService } from "@/server/maintenance/download-token";
import { FileDownloadAuditGateway } from "@/server/maintenance/download-audit";
import { FileMaintenanceGateway } from "@/server/maintenance/file-maintenance-gateway";
import {
  InvitationService,
  PrismaInvitationRepository,
} from "@/server/invitations/invitation-service";

const fixedMaintenancePaths = {
  adminOpsDirectory: "/var/lib/fitgridweb/admin-ops",
  portableBackupDirectory: "/var/lib/fitgridweb/portable-backups",
  portableBackupHistoryFile: "/var/lib/fitgridweb/admin-ops/status/backups.json",
} as const;

export function maintenanceRuntimeConfiguration(
  environment: Record<string, string | undefined> = process.env,
) {
  const maxUploadBytes = Number(
    environment.PORTABLE_BACKUP_MAX_BYTES
      ?? (environment.NODE_ENV === "production" ? Number.NaN : 536_870_912),
  );
  const secret = environment.BETTER_AUTH_SECRET;
  const configuredPaths = {
    adminOpsDirectory: environment.ADMIN_OPS_DIR,
    portableBackupDirectory: environment.PORTABLE_BACKUP_DIR,
    portableBackupHistoryFile: environment.PORTABLE_BACKUP_HISTORY_FILE,
  };
  const pathsAreFixed = Object.entries(fixedMaintenancePaths).every(
    ([key, value]) => configuredPaths[key as keyof typeof configuredPaths] === value,
  );
  if (
    !secret
    || secret.length < 32
    || !Number.isSafeInteger(maxUploadBytes)
    || maxUploadBytes <= 0
    || (environment.NODE_ENV === "production" && !pathsAreFixed)
  ) throw new Error("Maintenance runtime configuration is invalid");

  const paths = environment.NODE_ENV === "production"
    ? fixedMaintenancePaths
    : {
        adminOpsDirectory: configuredPaths.adminOpsDirectory ?? fixedMaintenancePaths.adminOpsDirectory,
        portableBackupDirectory: configuredPaths.portableBackupDirectory ?? fixedMaintenancePaths.portableBackupDirectory,
        portableBackupHistoryFile: configuredPaths.portableBackupHistoryFile ?? fixedMaintenancePaths.portableBackupHistoryFile,
      };
  return {
    ...paths,
    maxUploadBytes,
    downloadTokenSecret: secret,
    downloadTokenMarkerDirectory: `${paths.adminOpsDirectory}/status/download-tokens`,
  };
}

export function getRuntimeServices() {
  const maintenanceConfiguration = maintenanceRuntimeConfiguration();
  const prisma = getPrismaClient();
  const scope: OwnerScope = (ownerId, fn) => withOwnerScope(ownerId, fn, prisma);
  const ownerRefSecret = process.env.OWNER_REF_SECRET;
  const cursorSecret = process.env.CURSOR_SIGNING_SECRET ?? process.env.BETTER_AUTH_SECRET;
  if (!ownerRefSecret || ownerRefSecret.length < 32) {
    throw new Error("OWNER_REF_SECRET must contain at least 32 characters");
  }
  return {
    prisma,
    auth: getAuth(),
    grid: new GridService(scope),
    invitations: new InvitationService(new PrismaInvitationRepository(prisma)),
    admin: new AdminService(new PrismaAdminRepository(prisma), cursorSecret),
    imports: new ImportService(new PrismaImportRepository(prisma)),
    exports: new ExportService(scope, ownerRefSecret),
    maintenance: new FileMaintenanceGateway(maintenanceConfiguration),
    downloadTokens: new DownloadTokenService({
      secret: maintenanceConfiguration.downloadTokenSecret,
      markerDirectory: maintenanceConfiguration.downloadTokenMarkerDirectory,
    }),
    downloadAudits: new FileDownloadAuditGateway({
      adminOpsDirectory: maintenanceConfiguration.adminOpsDirectory,
    }),
  };
}

export type RuntimeServices = ReturnType<typeof getRuntimeServices>;
