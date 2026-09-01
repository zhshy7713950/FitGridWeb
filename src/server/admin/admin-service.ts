import type { PrismaClient } from "@/generated/prisma/client";
import { UserStatus } from "@/generated/prisma/client";
import { ApiError } from "@/server/http/api-error";

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
  constructor(private readonly repository: AdminRepository) {}

  async listUsers() {
    return { items: (await this.repository.list()).map(response), nextCursor: null };
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
