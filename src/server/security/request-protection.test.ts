import { describe, expect, it } from "vitest";

import { ApiError, toErrorResponse } from "@/server/http/api-error";

import { assertSameOrigin, FixedWindowRateLimiter, LoginAttemptLimiter } from "./request-protection";

describe("same-origin mutation protection", () => {
  it("accepts the public origin forwarded by the trusted reverse proxy", () => {
    const request = new Request("http://app:3000/api/v1/grid-trades", {
      method: "POST",
      headers: {
        origin: "https://grid.example.com",
        host: "grid.example.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it("rejects missing and cross-site origins for mutations", () => {
    for (const origin of [undefined, "https://evil.example"]) {
      const request = new Request("https://grid.example.com/api/v1/grid-trades", {
        method: "POST",
        headers: origin ? { origin } : undefined,
      });
      expect(() => assertSameOrigin(request)).toThrowError(ApiError);
    }
  });
});

describe("fixed-window rate limits", () => {
  it("returns 429 and Retry-After after the configured allowance", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(2, 60_000, () => now);
    limiter.consume("owner-a");
    limiter.consume("owner-a");
    let error: unknown;
    try {
      limiter.consume("owner-a");
    } catch (caught) {
      error = caught;
    }
    const response = toErrorResponse(error, "request-id");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    now += 60_001;
    expect(() => limiter.consume("owner-a")).not.toThrow();
  });
});

describe("login failure limit", () => {
  it("counts failures and clears them after a successful login", () => {
    const limiter = new LoginAttemptLimiter(2, 60_000, () => 1_000);
    limiter.recordFailure("ip+username");
    limiter.recordFailure("ip+username");
    expect(() => limiter.check("ip+username")).toThrowError(ApiError);
    limiter.clear("ip+username");
    expect(() => limiter.check("ip+username")).not.toThrow();
  });
});
