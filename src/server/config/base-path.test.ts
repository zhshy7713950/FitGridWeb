import { describe, expect, it } from "vitest";

import { cookiePath, normalizeBasePath } from "./base-path";

describe("production base path", () => {
  it("keeps local root deployments unchanged", () => {
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath("")).toBe("");
    expect(cookiePath(undefined)).toBe("/");
  });

  it("accepts the fixed FitGrid production path", () => {
    expect(normalizeBasePath("/fitgrid")).toBe("/fitgrid");
    expect(cookiePath("/fitgrid")).toBe("/fitgrid");
  });

  it("rejects paths that were not compiled into the application", () => {
    expect(() => normalizeBasePath("/other")).toThrow("APP_BASE_PATH");
    expect(() => normalizeBasePath("fitgrid")).toThrow("APP_BASE_PATH");
    expect(() => normalizeBasePath("/fitgrid/")).toThrow("APP_BASE_PATH");
  });
});
