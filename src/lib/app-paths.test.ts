import { describe, expect, it } from "vitest";

import { apiPath, loginRoute, safeReturnPath, unauthorizedRoute, withBasePath } from "./app-paths";

describe("application paths", () => {
  it("joins local and production paths without duplicate slashes", () => {
    expect(withBasePath("/login", "")).toBe("/login");
    expect(withBasePath("/login", "/fitgrid")).toBe("/fitgrid/login");
    expect(apiPath("/auth/login", "/fitgrid")).toBe("/fitgrid/api/v1/auth/login");
  });

  it.each([null, "", "//evil.example", "https://evil.example", "/admin", "/grids\\evil"])(
    "falls back from unsafe return path %s",
    (value) => expect(safeReturnPath(value)).toBe("/grids"),
  );

  it.each(["/grids/%2F..%2Fadmin", "/grids/%5C..%5Cadmin", "/grids/a/%2e%2e/admin"])(
    "rejects encoded separators and traversal in return path %s",
    (value) => expect(safeReturnPath(value)).toBe("/grids"),
  );

  it("keeps the grids route, query, and hash", () => {
    expect(safeReturnPath("/grids/abc?q=gold#row-2")).toBe("/grids/abc?q=gold#row-2");
    expect(loginRoute("/grids?q=gold")).toBe("/login?returnTo=%2Fgrids%3Fq%3Dgold");
    expect(unauthorizedRoute("/fitgrid/grids?q=gold", "/fitgrid")).toBe("/login?returnTo=%2Fgrids%3Fq%3Dgold");
  });

  it("preserves an exact root-mounted protected detail deep link", () => {
    expect(unauthorizedRoute("/grids/grid-1", "")).toBe(
      "/login?returnTo=%2Fgrids%2Fgrid-1",
    );
    expect(unauthorizedRoute("/grids/grid-1/edit?x=1#row", "")).toBe(
      "/login?returnTo=%2Fgrids%2Fgrid-1%2Fedit%3Fx%3D1%23row",
    );
  });

  it("strips the configured base path exactly once from a protected deep link", () => {
    expect(unauthorizedRoute("/fitgrid/grids/grid-1/edit?x=1#row", "/fitgrid")).toBe(
      "/login?returnTo=%2Fgrids%2Fgrid-1%2Fedit%3Fx%3D1%23row",
    );
    expect(unauthorizedRoute("/fitgrid/fitgrid/grids/grid-1", "/fitgrid")).toBe(
      "/login?returnTo=%2Fgrids",
    );
  });

  it.each([
    ["/admin?next=/grids/grid-1", ""],
    ["//evil.example/grids/grid-1", ""],
    ["/fitgrid/admin#users", "/fitgrid"],
    ["/fitgrid//evil.example/grids/grid-1", "/fitgrid"],
  ] as const)("falls back from an unsafe visible path %s", (visiblePath, basePath) => {
    expect(unauthorizedRoute(visiblePath, basePath)).toBe("/login?returnTo=%2Fgrids");
  });
});
