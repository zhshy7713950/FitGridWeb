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

export interface AdminRepository {
  list(): Promise<ManagedUser[]>;
  find(id: string): Promise<ManagedUser | null>;
  countActiveAdmins(): Promise<number>;
  setStatus(id: string, status: "active" | "disabled"): Promise<ManagedUser>;
  revokeSessions(userId: string): Promise<void>;
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
    const user = await this.repository.find(userId);
    if (!user) throw new ApiError(404, "USER_NOT_FOUND", "账号不存在");
    if (status === "disabled" && user.role === "admin" && user.status === "active") {
      if ((await this.repository.countActiveAdmins()) <= 1) {
        throw new ApiError(409, "LAST_ACTIVE_ADMIN", "不能禁用最后一个有效管理员");
      }
    }
    const updated = await this.repository.setStatus(userId, status);
    if (status === "disabled") await this.repository.revokeSessions(userId);
    return response(updated);
  }
}

export class PrismaAdminRepository implements AdminRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<ManagedUser[]> {
    const users = await this.prisma.user.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    return users.map((user) => ({
      id: user.id,
      username: user.username ?? user.name,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    }));
  }

  async find(id: string): Promise<ManagedUser | null> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user
      ? {
          id: user.id,
          username: user.username ?? user.name,
          role: user.role,
          status: user.status,
          createdAt: user.createdAt,
        }
      : null;
  }

  countActiveAdmins(): Promise<number> {
    return this.prisma.user.count({ where: { role: "admin", status: "active" } });
  }

  async setStatus(id: string, status: "active" | "disabled"): Promise<ManagedUser> {
    const user = await this.prisma.user.update({
      where: { id },
      data: { status: status === "active" ? UserStatus.active : UserStatus.disabled },
    });
    return {
      id: user.id,
      username: user.username ?? user.name,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    };
  }

  async revokeSessions(userId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { userId } });
  }
}
