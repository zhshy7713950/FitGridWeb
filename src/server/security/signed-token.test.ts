import { describe, expect, it } from "vitest";

import { signScopedToken, verifyScopedToken } from "@/server/security/signed-token";

const secret = "test-secret-that-is-long-enough-for-hmac";

describe("signed scoped tokens", () => {
  it("round trips a live token for the same owner", () => {
    const token = signScopedToken(
      { ownerId: "owner-a", id: "row-1", exp: 2_000_000_000 },
      secret,
    );

    expect(verifyScopedToken(token, secret, { ownerId: "owner-a", now: 1_900_000_000 })).toEqual({
      ownerId: "owner-a",
      id: "row-1",
      exp: 2_000_000_000,
    });
  });

  it.each([
    ["tampered payload", (token: string) => `e30.${token.split(".")[1]}`, secret, "owner-a"],
    ["wrong secret", (token: string) => token, `${secret}-wrong`, "owner-a"],
    ["wrong owner", (token: string) => token, secret, "owner-b"],
  ])("rejects %s", (_label, mutate, verificationSecret, ownerId) => {
    const token = signScopedToken({ ownerId: "owner-a", exp: 2_000_000_000 }, secret);
    expect(() =>
      verifyScopedToken(mutate(token), verificationSecret, { ownerId, now: 1_900_000_000 }),
    ).toThrowError(expect.objectContaining({ code: "SIGNED_TOKEN_INVALID" }));
  });

  it("rejects an expired token", () => {
    const token = signScopedToken({ ownerId: "owner-a", exp: 100 }, secret);
    expect(() => verifyScopedToken(token, secret, { now: 101 })).toThrowError(
      expect.objectContaining({ code: "SIGNED_TOKEN_EXPIRED" }),
    );
  });
});
