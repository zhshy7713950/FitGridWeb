import { describe, expect, it } from "vitest";

import {
  AdminService,
  type AdminRepository,
  type ManagedUser,
} from "@/server/admin/admin-service";

class MemoryAdmins implements AdminRepository {
  users: ManagedUser[] = [
    {
      id: "admin",
      username: "admin",
      role: "admin",
      status: "active",
      createdAt: new Date("2026-09-01T00:00:00Z"),
    },
    {
      id: "member",
      username: "member",
      role: "member",
      status: "active",
      createdAt: new Date("2026-09-01T00:00:00Z"),
    },
  ];
  revoked: string[] = [];

  async list(): Promise<ManagedUser[]> {
    return this.users;
  }
  async find(id: string): Promise<ManagedUser | null> {
    return this.users.find((user) => user.id === id) ?? null;
  }
  async countActiveAdmins(): Promise<number> {
    return this.users.filter((user) => user.role === "admin" && user.status === "active").length;
  }
  async setStatus(id: string, status: "active" | "disabled"): Promise<ManagedUser> {
    const user = (await this.find(id))!;
    user.status = status;
    return user;
  }
  async revokeSessions(userId: string): Promise<void> {
    this.revoked.push(userId);
  }
}

describe("AdminService", () => {
  it("does not expose product counts when listing accounts", async () => {
    const users = await new AdminService(new MemoryAdmins()).listUsers();
    expect(users.items[0]).toEqual({
      id: "admin",
      username: "admin",
      role: "admin",
      status: "active",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("returns a stable opaque cursor instead of ignoring the documented limit", async () => {
    const service = new AdminService(new MemoryAdmins(), "admin-cursor-secret-at-least-32-chars");
    const first = await service.listUsers({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf("string");
    const second = await service.listUsers({ limit: 1, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual(["member"]);
  });

  it("disables a member and revokes every session", async () => {
    const repository = new MemoryAdmins();
    await expect(new AdminService(repository).updateStatus("member", "disabled")).resolves.toMatchObject({
      status: "disabled",
    });
    expect(repository.revoked).toEqual(["member"]);
  });

  it("refuses to disable the final active administrator", async () => {
    const repository = new MemoryAdmins();
    await expect(new AdminService(repository).updateStatus("admin", "disabled")).rejects.toMatchObject({
      status: 409,
      code: "LAST_ACTIVE_ADMIN",
    });
  });
});
