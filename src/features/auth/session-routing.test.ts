import { describe, expect, it } from "vitest";
import { homeRoute, protectedLoginRoute } from "./session-routing";

describe("session page routing", () => {
  it("routes anonymous visitors to login and active users to grids", () => {
    expect(homeRoute(null)).toBe("/login");
    expect(homeRoute({ id: "u1", username: "admin", role: "admin", status: "active" })).toBe("/grids");
  });

  it("encodes only a safe application return route", () => {
    expect(protectedLoginRoute("/grids/abc?q=gold")).toBe("/login?returnTo=%2Fgrids%2Fabc%3Fq%3Dgold");
    expect(protectedLoginRoute("https://evil.example")).toBe("/login?returnTo=%2Fgrids");
  });
});
