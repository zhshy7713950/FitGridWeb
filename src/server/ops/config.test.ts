import { describe, expect, it } from "vitest";

import { validateDeploymentEnvironment, validateRestoreTarget } from "./config";

const validEnvironment = {
  DOMAIN: "grid.example.com",
  APP_BASE_PATH: "/fitgrid",
  APP_PORT: "3300",
  PUBLIC_HTTPS_PORT: "443",
  BETTER_AUTH_URL: "https://grid.example.com/fitgrid",
  APP_IMAGE: "ghcr.io/zhshy7713950/fitgridweb:sha-2ca7f41000000000000000000000000000000000",
  POSTGRES_DB: "fitgridweb",
  POSTGRES_USER: "fitgridmigrate",
  POSTGRES_PASSWORD: "database-secret-that-is-not-a-default",
  APP_DATABASE_USER: "fitgridapp",
  APP_DATABASE_PASSWORD: "runtime-secret-that-is-not-a-default",
  DATABASE_URL: "postgresql://fitgridapp:runtime-secret-that-is-not-a-default@db:5432/fitgridweb",
  MIGRATION_DATABASE_URL: "postgresql://fitgridmigrate:database-secret-that-is-not-a-default@db:5432/fitgridweb",
  BETTER_AUTH_SECRET: "auth-secret-at-least-thirty-two-characters",
  OWNER_REF_SECRET: "owner-secret-at-least-thirty-two-characters",
  ADMIN_OPS_WEB_DIR: "/var/lib/fitgridweb/admin-ops/web",
  ADMIN_OPS_ROOT_DIR: "/var/lib/fitgridweb/admin-ops/root",
  PORTABLE_BACKUP_DIR: "/var/lib/fitgridweb/portable-backups",
  PORTABLE_BACKUP_HISTORY_FILE: "/var/lib/fitgridweb/admin-ops/web/status/backups.json",
  PORTABLE_BACKUP_MAX_BYTES: "536870912",
  PORTABLE_BACKUP_READER_GID: "1001",
};

describe("production configuration", () => {
  it("accepts fixed images and independent runtime secrets", () => {
    expect(validateDeploymentEnvironment(validEnvironment).APP_IMAGE).toContain("sha-");
  });

  it.each([
    ["missing secret", { BETTER_AUTH_SECRET: "" }],
    ["short secret", { OWNER_REF_SECRET: "too-short" }],
    ["default database password", { POSTGRES_PASSWORD: "changeme" }],
    ["mutable image", { APP_IMAGE: "ghcr.io/example/fitgridweb:latest" }],
    ["same auth and owner secret", { OWNER_REF_SECRET: validEnvironment.BETTER_AUTH_SECRET }],
    ["unchanged placeholder", { BETTER_AUTH_SECRET: "REPLACE_WITH_AT_LEAST_32_RANDOM_BYTES" }],
    ["wrong base path", { APP_BASE_PATH: "/other" }],
    ["privileged app port", { APP_PORT: "443" }],
    ["invalid public HTTPS port", { PUBLIC_HTTPS_PORT: "70000" }],
    ["auth URL outside base path", { BETTER_AUTH_URL: "https://grid.example.com/" }],
    ["relative maintenance spool", { ADMIN_OPS_WEB_DIR: "var/lib/fitgridweb/admin-ops/web" }],
    ["root maintenance spool", { ADMIN_OPS_ROOT_DIR: "/" }],
    ["history outside the web status directory", { PORTABLE_BACKUP_HISTORY_FILE: "/tmp/backups.json" }],
    ["zero portable backup limit", { PORTABLE_BACKUP_MAX_BYTES: "0" }],
    ["non-numeric portable backup reader group", { PORTABLE_BACKUP_READER_GID: "app" }],
    ["exponential portable backup reader group", { PORTABLE_BACKUP_READER_GID: "1e3" }],
    ["root portable backup reader group", { PORTABLE_BACKUP_READER_GID: "0" }],
    ["root tree exposed through portable mount", { ADMIN_OPS_ROOT_DIR: validEnvironment.PORTABLE_BACKUP_DIR }],
  ])("rejects %s", (_name, patch) => {
    expect(() => validateDeploymentEnvironment({ ...validEnvironment, ...patch })).toThrow();
  });
});

describe("restore target guard", () => {
  it.each([
    "",
    "postgresql://postgres@db:5432/postgres",
    "postgresql://postgres@db:5432/template1",
    validEnvironment.DATABASE_URL,
    validEnvironment.MIGRATION_DATABASE_URL,
    "postgresql://different-user:different-password@db:5432/fitgridweb",
  ])("rejects unsafe target %s", (target) => {
    expect(() => validateRestoreTarget(
      target,
      validEnvironment.DATABASE_URL,
      validEnvironment.MIGRATION_DATABASE_URL,
    )).toThrow();
  });

  it("accepts a distinct named exercise database", () => {
    const target = "postgresql://restore@db:5432/fitgridweb_restore_20260901";
    expect(validateRestoreTarget(
      target,
      validEnvironment.DATABASE_URL,
      validEnvironment.MIGRATION_DATABASE_URL,
    )).toBe(target);
  });
});
