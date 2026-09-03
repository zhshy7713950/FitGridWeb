import type { PrismaClient } from "@/generated/prisma/client";
import { UserStatus } from "@/generated/prisma/client";
import { ApiError } from "@/server/http/api-error";
import { signScopedToken, verifyScopedToken } from "@/server/security/signed-token";

export interface ManagedUser {
  id: string;
  username: string;
  role: "member" | "admin";
  status: "active" | "disabled";
  createdAt: Date;
}

export type StatusTransitionResult =
  | { kind: "updated"; user: ManagedUser }
  | { kind: "not_found" }
  | { kind: "last_active_admin" };

export interface AdminRepository {
  list(): Promise<ManagedUser[]>;
  updateStatusAtomically(
    id: string,
    status: "active" | "disabled",
  ): Promise<StatusTransitionResult>;
}

function managedUser(user: {
  id: string;
  name: string;
  username: string | null;
  role: "member" | "admin";
  status: "active" | "disabled";
  createdAt: Date;
}): ManagedUser {
  return {
    id: user.id,
    username: user.username ?? user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}

function response(user: ManagedUser) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

function isSerializableConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "P2034") return true;
  if (!("cause" in error) || typeof error.cause !== "object" || error.cause === null) {
    return false;
  }
  return "kind" in error.cause
    && error.cause.kind === "TransactionWriteConflict"
    && "originalCode" in error.cause
    && error.cause.originalCode === "40001";
}

export class AdminService {
  constructor(
    private readonly repository: AdminRepository,
    private readonly cursorSecret = process.env.CURSOR_SIGNING_SECRET ?? process.env.BETTER_AUTH_SECRET,
  ) {}

  async listUsers(query: { cursor?: string; limit?: number } = {}) {
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError(422, "LIMIT_OUT_OF_RANGE", "limit 必须介于 1 和 100 之间");
    }
    const users = await this.repository.list();
    let start = 0;
    if (query.cursor) {
      if (!this.cursorSecret || this.cursorSecret.length < 32) {
        throw new Error("CURSOR_SIGNING_SECRET or BETTER_AUTH_SECRET must contain at least 32 characters");
      }
      const cursor = verifyScopedToken<{ ownerId: string; id: string; exp: number }>(
        query.cursor,
        this.cursorSecret,
        { ownerId: "admin-users" },
      );
      const index = users.findIndex((user) => user.id === cursor.id);
      if (index < 0) throw new ApiError(400, "SIGNED_TOKEN_INVALID", "分页游标无效");
      start = index + 1;
    }
    const page = users.slice(start, start + limit);
    const hasMore = start + page.length < users.length;
    let nextCursor: string | null = null;
    if (hasMore) {
      if (!this.cursorSecret || this.cursorSecret.length < 32) {
        throw new Error("CURSOR_SIGNING_SECRET or BETTER_AUTH_SECRET must contain at least 32 characters");
      }
      nextCursor = signScopedToken(
        {
          ownerId: "admin-users",
          id: page.at(-1)!.id,
          exp: Math.floor(Date.now() / 1_000) + 24 * 60 * 60,
        },
        this.cursorSecret,
      );
    }
    return { items: page.map(response), nextCursor };
  }

  async updateStatus(userId: string, status: "active" | "disabled") {
    const result = await this.repository.updateStatusAtomically(userId, status);
    if (result.kind === "not_found") {
      throw new ApiError(404, "USER_NOT_FOUND", "账号不存在");
    }
    if (result.kind === "last_active_admin") {
      throw new ApiError(409, "LAST_ACTIVE_ADMIN", "不能禁用最后一个有效管理员");
    }
    return response(result.user);
  }
}

export class PrismaAdminRepository implements AdminRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<ManagedUser[]> {
    const users = await this.prisma.user.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    return users.map(managedUser);
  }

  async updateStatusAtomically(
    id: string,
    status: "active" | "disabled",
  ): Promise<StatusTransitionResult> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const user = await transaction.user.findUnique({ where: { id } });
            if (!user) return { kind: "not_found" } as const;

            if (status === "disabled" && user.role === "admin" && user.status === "active") {
              const activeAdmins = await transaction.user.count({
                where: { role: "admin", status: "active" },
              });
              if (activeAdmins <= 1) return { kind: "last_active_admin" } as const;
            }

            const updated = await transaction.user.update({
              where: { id },
              data: { status: status === "active" ? UserStatus.active : UserStatus.disabled },
            });
            if (status === "disabled") {
              await transaction.session.deleteMany({ where: { userId: id } });
            }
            return { kind: "updated", user: managedUser(updated) } as const;
          },
          { isolationLevel: "Serializable" },
        );
      } catch (error) {
        if (!isSerializableConflict(error) || attempt === maxAttempts) throw error;
      }
    }
    throw new Error("unreachable serializable transaction retry state");
  }
}
