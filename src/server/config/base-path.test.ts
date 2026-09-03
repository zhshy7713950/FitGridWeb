import { describe, expect, it } from "vitest";

import { cookiePath, invitationUrl, normalizeBasePath } from "./base-path";

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

  it.each([
    [undefined, "https://fitgrid.example/invite/token%2Fpart"],
    ["/fitgrid", "https://fitgrid.example/fitgrid/invite/token%2Fpart"],
  ])("builds a same-origin invitation URL for base path %s", (basePath, expected) => {
    expect(invitationUrl(
      "https://fitgrid.example/api/v1/admin/invitations?ignored=1",
      "token/part",
      basePath,
    )).toBe(expected);
  });

  it("rejects an unsupported invitation base path", () => {
    expect(() => invitationUrl("https://fitgrid.example/api", "token", "/other"))
      .toThrow("APP_BASE_PATH");
  });
});
