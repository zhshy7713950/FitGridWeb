import { describe, expect, it } from "vitest";

import { collectAdminCredentials } from "@/server/cli/create-admin";

describe("initial administrator prompt", () => {
  it("retries invalid and mismatched passwords before returning valid credentials", async () => {
    const usernames = ["admin", "admin", "admin"];
    const passwords = [
      "too-short",
      "too-short",
      "correct horse battery",
      "different confirmation",
      "correct horse battery",
      "correct horse battery",
    ];
    const errors: string[] = [];

    const credentials = await collectAdminCredentials(
      async () => usernames.shift() ?? "",
      async () => passwords.shift() ?? "",
      (message) => errors.push(message),
    );

    expect(credentials).toEqual({
      username: "admin",
      password: "correct horse battery",
    });
    expect(errors).toEqual([
      "密码长度必须为 12–128 个字符",
      "Passwords do not match",
    ]);
  });
});
