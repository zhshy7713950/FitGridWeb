import { describe, expect, it } from "vitest";

import { validateDeploymentEnvironment, validateRestoreTarget } from "./config";

const validEnvironment = {
  DOMAIN: "grid.example.com",
  APP_IMAGE: "ghcr.io/example/fitgridweb:sha-2ca7f41",
  POSTGRES_DB: "fitgridweb",
  POSTGRES_USER: "fitgridapp",
  POSTGRES_PASSWORD: "database-secret-that-is-not-a-default",
  DATABASE_URL: "postgresql://fitgridapp:secret@db:5432/fitgridweb",
  MIGRATION_DATABASE_URL: "postgresql://fitgridmigrate:secret@db:5432/fitgridweb",
  BETTER_AUTH_SECRET: "auth-secret-at-least-thirty-two-characters",
  OWNER_REF_SECRET: "owner-secret-at-least-thirty-two-characters",
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
  ])("rejects unsafe target %s", (target) => {
    expect(() => validateRestoreTarget(target, validEnvironment.DATABASE_URL)).toThrow();
  });

  it("accepts a distinct named exercise database", () => {
    const target = "postgresql://restore@db:5432/fitgridweb_restore_20260901";
    expect(validateRestoreTarget(target, validEnvironment.DATABASE_URL)).toBe(target);
  });
});
