import { AdminService, PrismaAdminRepository } from "@/server/admin/admin-service";
import { getAuth } from "@/server/auth/auth";
import { getPrismaClient } from "@/server/db/client";
import { GridService, type OwnerScope } from "@/server/grid-application/grid-service";
import { withOwnerScope } from "@/server/grid-persistence/prisma-grid-trade-store";
import { ExportService } from "@/server/import-export/export-service";
import { ImportService } from "@/server/import-export/import-service";
import { PrismaImportRepository } from "@/server/import-export/prisma-import-repository";
import {
  InvitationService,
  PrismaInvitationRepository,
} from "@/server/invitations/invitation-service";

export function getRuntimeServices() {
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
  };
}

export type RuntimeServices = ReturnType<typeof getRuntimeServices>;
