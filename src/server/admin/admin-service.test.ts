import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  AdminService,
  PrismaAdminRepository,
  type AdminRepository,
  type ManagedUser,
  type StatusTransitionResult,
} from "@/server/admin/admin-service";

class MemoryAdmins implements AdminRepository {
  users: ManagedUser[] = [
    {
      id: "admin-a",
      username: "admin-a",
      role: "admin",
      status: "active",
      createdAt: new Date("2026-09-01T00:00:00Z"),
    },
    {
      id: "admin-b",
      username: "admin-b",
      role: "admin",
      status: "active",
      createdAt: new Date("2026-09-01T00:00:01Z"),
    },
    {
      id: "member",
      username: "member",
      role: "member",
      status: "active",
      createdAt: new Date("2026-09-01T00:00:02Z"),
    },
  ];
  revoked: string[] = [];
  private tail = Promise.resolve();

  async list(): Promise<ManagedUser[]> {
    return this.users;
  }

  async updateStatusAtomically(
    id: string,
    status: "active" | "disabled",
  ): Promise<StatusTransitionResult> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const user = this.users.find((candidate) => candidate.id === id);
      if (!user) return { kind: "not_found" };
      if (
        status === "disabled" &&
        user.role === "admin" &&
        user.status === "active" &&
        this.users.filter(
          (candidate) => candidate.role === "admin" && candidate.status === "active",
        ).length <= 1
      ) {
        return { kind: "last_active_admin" };
      }
      user.status = status;
      if (status === "disabled") this.revoked.push(id);
      return { kind: "updated", user };
    } finally {
      release();
    }
  }
}

describe("AdminService", () => {
  it("does not expose product counts when listing accounts", async () => {
    const users = await new AdminService(new MemoryAdmins()).listUsers();
    expect(users.items[0]).toEqual({
      id: "admin-a",
      username: "admin-a",
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
    expect(second.items.map((item) => item.id)).toEqual(["admin-b"]);
  });

  it("disables a member and revokes every session in the atomic transition", async () => {
    const repository = new MemoryAdmins();
    await expect(new AdminService(repository).updateStatus("member", "disabled")).resolves.toMatchObject({
      status: "disabled",
    });
    expect(repository.revoked).toEqual(["member"]);
  });

  it("allows at most one of two active administrators to disable the other", async () => {
    const repository = new MemoryAdmins();
    const service = new AdminService(repository);

    const outcomes = await Promise.allSettled([
      service.updateStatus("admin-a", "disabled"),
      service.updateStatus("admin-b", "disabled"),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { status: 409, code: "LAST_ACTIVE_ADMIN" },
    });
    const activeAdmins = repository.users.filter(
      (user) => user.role === "admin" && user.status === "active",
    );
    expect(activeAdmins).toHaveLength(1);
    expect(repository.revoked).toEqual([
      repository.users.find((user) => user.role === "admin" && user.status === "disabled")!.id,
    ]);
    expect(repository.revoked).not.toContain(activeAdmins[0].id);
  });

  it("maps an atomic not-found result without attempting a separate lookup", async () => {
    await expect(new AdminService(new MemoryAdmins()).updateStatus("missing", "disabled")).rejects.toMatchObject({
      status: 404,
      code: "USER_NOT_FOUND",
    });
  });
});

function managedDatabaseUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "member",
    name: "Member",
    username: "member",
    email: "member@example.test",
    emailVerified: true,
    image: null,
    role: "member",
    status: "active",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

describe("PrismaAdminRepository", () => {
  it("checks, updates, and revokes sessions inside one serializable transaction", async () => {
    const calls: string[] = [];
    const tx = {
      user: {
        findUnique: vi.fn(async () => {
          calls.push("find");
          return managedDatabaseUser({ role: "admin" });
        }),
        count: vi.fn(async () => {
          calls.push("count");
          return 2;
        }),
        update: vi.fn(async () => {
          calls.push("update");
          return managedDatabaseUser({ status: "disabled" });
        }),
      },
      session: {
        deleteMany: vi.fn(async () => {
          calls.push("revoke");
          return { count: 2 };
        }),
      },
    };
    const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
    const repository = new PrismaAdminRepository({ $transaction: transaction } as unknown as PrismaClient);

    await expect(repository.updateStatusAtomically("member", "disabled")).resolves.toMatchObject({
      kind: "updated",
      user: { id: "member", status: "disabled" },
    });

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(calls).toEqual(["find", "count", "update", "revoke"]);
  });

  it("returns LAST_ACTIVE_ADMIN without updating status or revoking sessions", async () => {
    const tx = {
      user: {
        findUnique: vi.fn(async () => managedDatabaseUser({ role: "admin" })),
        count: vi.fn(async () => 1),
        update: vi.fn(),
      },
      session: { deleteMany: vi.fn() },
    };
    const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
    const repository = new PrismaAdminRepository({ $transaction: transaction } as unknown as PrismaClient);

    await expect(repository.updateStatusAtomically("admin", "disabled")).resolves.toEqual({
      kind: "last_active_admin",
    });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.session.deleteMany).not.toHaveBeenCalled();
  });

  it("retries a serializable write conflict with a bounded P2034 policy", async () => {
    const tx = {
      user: {
        findUnique: vi.fn(async () => managedDatabaseUser()),
        count: vi.fn(async () => 2),
        update: vi.fn(async () => managedDatabaseUser({ status: "disabled" })),
      },
      session: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    };
    const conflict = Object.assign(new Error("write conflict"), { code: "P2034" });
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));
    const repository = new PrismaAdminRepository({ $transaction: transaction } as unknown as PrismaClient);

    await expect(repository.updateStatusAtomically("member", "disabled")).resolves.toMatchObject({
      kind: "updated",
    });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("stops retrying after three P2034 conflicts", async () => {
    const conflict = Object.assign(new Error("write conflict"), { code: "P2034" });
    const transaction = vi.fn(async () => {
      throw conflict;
    });
    const repository = new PrismaAdminRepository({ $transaction: transaction } as unknown as PrismaClient);

    await expect(repository.updateStatusAtomically("member", "disabled")).rejects.toBe(conflict);
    expect(transaction).toHaveBeenCalledTimes(3);
  });
});
