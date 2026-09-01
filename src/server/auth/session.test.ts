import { describe, expect, it } from "vitest";

import type { FitGridAuth } from "./auth";
import { requireAdmin, requireSession } from "./session";

function authWith(user?: { id: string; name: string; role: string; status: string }): FitGridAuth {
  return {
    api: {
      getSession: async () => user ? { user, session: { expiresAt: new Date() } } : null,
    },
  } as unknown as FitGridAuth;
}

describe("API authorization matrix", () => {
  it("returns 401 for anonymous and disabled sessions", async () => {
    await expect(requireSession(new Headers(), authWith())).rejects.toMatchObject({ status: 401 });
    await expect(
      requireSession(new Headers(), authWith({ id: "disabled", name: "disabled", role: "member", status: "disabled" })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("returns 403 when a member calls an admin boundary", async () => {
    const auth = authWith({ id: "member", name: "member", role: "member", status: "active" });
    await expect(requireAdmin(new Headers(), auth)).rejects.toMatchObject({ status: 403 });
  });

  it("allows an active administrator without granting product superuser access", async () => {
    const auth = authWith({ id: "admin", name: "admin", role: "admin", status: "active" });
    await expect(requireAdmin(new Headers(), auth)).resolves.toMatchObject({ id: "admin", role: "admin" });
  });
});
