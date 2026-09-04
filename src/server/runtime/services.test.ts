import { describe, expect, it } from "vitest";

import { maintenanceRuntimeConfiguration } from "./services";

const secret = "better-auth-secret-that-is-at-least-32-characters";

describe("maintenance runtime configuration", () => {
  it("uses only the fixed container spool paths in production", () => {
    expect(maintenanceRuntimeConfiguration({
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: secret,
      ADMIN_OPS_DIR: "/var/lib/fitgridweb/admin-ops",
      PORTABLE_BACKUP_DIR: "/var/lib/fitgridweb/portable-backups",
      PORTABLE_BACKUP_HISTORY_FILE: "/var/lib/fitgridweb/admin-ops/status/backups.json",
      PORTABLE_BACKUP_MAX_BYTES: "536870912",
    })).toEqual({
      adminOpsDirectory: "/var/lib/fitgridweb/admin-ops",
      portableBackupDirectory: "/var/lib/fitgridweb/portable-backups",
      portableBackupHistoryFile: "/var/lib/fitgridweb/admin-ops/status/backups.json",
      maxUploadBytes: 536870912,
      downloadTokenSecret: secret,
      downloadTokenMarkerDirectory: "/var/lib/fitgridweb/admin-ops/status/download-tokens",
    });
  });

  it.each([
    ["missing secret", { BETTER_AUTH_SECRET: undefined }],
    ["missing spool", { ADMIN_OPS_DIR: undefined }],
    ["host path injected", { ADMIN_OPS_DIR: "/srv/private/admin-ops" }],
    ["invalid upload limit", { PORTABLE_BACKUP_MAX_BYTES: "NaN" }],
  ])("fails closed in production for %s", (_label, override) => {
    expect(() => maintenanceRuntimeConfiguration({
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: secret,
      ADMIN_OPS_DIR: "/var/lib/fitgridweb/admin-ops",
      PORTABLE_BACKUP_DIR: "/var/lib/fitgridweb/portable-backups",
      PORTABLE_BACKUP_HISTORY_FILE: "/var/lib/fitgridweb/admin-ops/status/backups.json",
      PORTABLE_BACKUP_MAX_BYTES: "536870912",
      ...override,
    })).toThrow("Maintenance runtime configuration is invalid");
  });
});
