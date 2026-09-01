import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";

import { Prisma, UserRole, UserStatus, type PrismaClient } from "@/generated/prisma/client";
import { internalEmailForUsername, validateCredentials } from "@/server/auth/user-policy";
import { ApiError } from "@/server/http/api-error";

export interface InvitationRecord {
  id: string;
  tokenDigest: string;
  createdById: string;
  expiresAt: Date;
  usedAt: Date | null;
  usedById: string | null;
  createdAt: Date;
}

export interface InvitationAcceptInput {
  tokenDigest: string;
  now: Date;
  userId: string;
  username: string;
  email: string;
  passwordHash: string;
}

export interface InvitationRepository {
  create(record: InvitationRecord): Promise<InvitationRecord>;
  findByDigest(digest: string): Promise<InvitationRecord | null>;
  accept(input: InvitationAcceptInput): Promise<"accepted" | "unavailable" | "username_conflict">;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class InvitationService {
  constructor(
    private readonly repository: InvitationRepository,
    private readonly passwordHasher: (password: string) => Promise<string> = hashPassword,
  ) {}

  async create(createdById: string, expiresInHours = 24, now = new Date()) {
    if (!Number.isSafeInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 168) {
      throw new ApiError(422, "INVITATION_TTL_INVALID", "邀请有效期必须为 1–168 小时");
    }
    const token = randomBytes(32).toString("base64url");
    const record: InvitationRecord = {
      id: randomUUID(),
      tokenDigest: digest(token),
      createdById,
      expiresAt: new Date(now.valueOf() + expiresInHours * 60 * 60 * 1000),
      usedAt: null,
      usedById: null,
      createdAt: now,
    };
    await this.repository.create(record);
    return { id: record.id, token, expiresAt: record.expiresAt.toISOString() };
  }

  async status(token: string, now = new Date()) {
    const record = await this.repository.findByDigest(digest(token));
    if (!record) throw new ApiError(404, "INVITATION_NOT_FOUND", "邀请不存在");
    return {
      status: record.usedAt ? "used" : record.expiresAt <= now ? "expired" : "valid",
      expiresAt: record.expiresAt.toISOString(),
    } as const;
  }

  async accept(token: string, usernameValue: unknown, passwordValue: unknown, now = new Date()) {
    const { username, password } = validateCredentials(usernameValue, passwordValue);
    const userId = randomUUID();
    const result = await this.repository.accept({
      tokenDigest: digest(token),
      now,
      userId,
      username,
      email: internalEmailForUsername(username),
      passwordHash: await this.passwordHasher(password),
    });
    if (result === "unavailable") {
      throw new ApiError(404, "INVITATION_NOT_FOUND", "邀请不存在或已失效");
    }
    if (result === "username_conflict") {
      throw new ApiError(409, "USERNAME_CONFLICT", "用户名已存在", {
        username: ["用户名已存在"],
      });
    }
    return {
      id: userId,
      username,
      role: "member" as const,
      status: "active" as const,
      createdAt: now.toISOString(),
    };
  }
}

function invitationRecord(record: {
  id: string;
  tokenDigest: string;
  createdById: string;
  expiresAt: Date;
  usedAt: Date | null;
  usedById: string | null;
  createdAt: Date;
}): InvitationRecord {
  return record;
}

export class PrismaInvitationRepository implements InvitationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(record: InvitationRecord): Promise<InvitationRecord> {
    return invitationRecord(await this.prisma.invitation.create({ data: record }));
  }

  async findByDigest(tokenDigest: string): Promise<InvitationRecord | null> {
    const record = await this.prisma.invitation.findUnique({ where: { tokenDigest } });
    return record ? invitationRecord(record) : null;
  }

  async accept(input: InvitationAcceptInput) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const invitation = await transaction.invitation.findUnique({
          where: { tokenDigest: input.tokenDigest },
        });
        if (!invitation || invitation.usedAt || invitation.expiresAt <= input.now) {
          return "unavailable" as const;
        }
        await transaction.user.create({
          data: {
            id: input.userId,
            name: input.username,
            email: input.email,
            emailVerified: true,
            username: input.username,
            role: UserRole.member,
            status: UserStatus.active,
            createdAt: input.now,
            updatedAt: input.now,
          },
        });
        await transaction.account.create({
          data: {
            id: randomUUID(),
            accountId: input.userId,
            providerId: "credential",
            issuer: "local:credential",
            userId: input.userId,
            password: input.passwordHash,
            createdAt: input.now,
            updatedAt: input.now,
          },
        });
        const consumed = await transaction.invitation.updateMany({
          where: { id: invitation.id, usedAt: null, expiresAt: { gt: input.now } },
          data: { usedAt: input.now, usedById: input.userId },
        });
        if (consumed.count !== 1) throw new Error("INVITATION_CONCURRENTLY_CONSUMED");
        return "accepted" as const;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return "username_conflict" as const;
      }
      if (error instanceof Error && error.message === "INVITATION_CONCURRENTLY_CONSUMED") {
        return "unavailable" as const;
      }
      throw error;
    }
  }
}
