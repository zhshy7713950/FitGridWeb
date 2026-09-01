import { describe, expect, it } from "vitest";

import { internalEmailForUsername, validateCredentials } from "@/server/auth/user-policy";

describe("account credential policy", () => {
  it("normalizes usernames and derives a non-reversible internal email", () => {
    const credentials = validateCredentials("  Alice.User  ", "correct horse battery");
    expect(credentials.username).toBe("alice.user");
    expect(internalEmailForUsername(credentials.username)).toMatch(
      /^[0-9a-f]{64}@users\.fitgridweb\.invalid$/,
    );
  });

  it.each([
    ["ab", "correct horse battery", "USERNAME_INVALID"],
    ["contains space", "correct horse battery", "USERNAME_INVALID"],
    ["valid_user", "too-short", "PASSWORD_INVALID"],
  ])("rejects invalid credentials", (username, password, code) => {
    expect(() => validateCredentials(username, password)).toThrowError(
      expect.objectContaining({ code }),
    );
  });
});
