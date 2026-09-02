import { ClientApiError } from "@/lib/api-client";
import { withBasePath } from "@/lib/app-paths";

import type { CreatedInvitation, ManagedUser, ManagedUserPage } from "./types";

const users: ManagedUser[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    username: "demo",
    role: "admin",
    status: "active",
    createdAt: "2026-09-01T00:00:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    username: "ledger.operator",
    role: "member",
    status: "active",
    createdAt: "2026-09-01T08:30:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    username: "audit.viewer",
    role: "member",
    status: "disabled",
    createdAt: "2026-09-02T02:15:00.000Z",
  },
];

let invitationSequence = 0;

function assertActive(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function cursorOffset(cursor?: string): number {
  if (!cursor) return 0;
  const match = /^demo:(\d+)$/.exec(cursor);
  if (!match) throw new ClientApiError(400, "SIGNED_TOKEN_INVALID", "分页游标无效");
  return Number(match[1]);
}

export function listDemoUsers({
  cursor,
  limit = 20,
  signal,
}: {
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
} = {}): ManagedUserPage {
  assertActive(signal);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ClientApiError(422, "LIMIT_OUT_OF_RANGE", "limit 必须介于 1 和 100 之间");
  }
  const offset = cursorOffset(cursor);
  const items = users.slice(offset, offset + limit).map((user) => ({ ...user }));
  const nextOffset = offset + items.length;
  return {
    items,
    nextCursor: nextOffset < users.length ? `demo:${nextOffset}` : null,
  };
}

export function updateDemoUserStatus(
  userId: string,
  status: ManagedUser["status"],
  signal?: AbortSignal,
): ManagedUser {
  assertActive(signal);
  const user = users.find((candidate) => candidate.id === userId);
  if (!user) throw new ClientApiError(404, "USER_NOT_FOUND", "账号不存在", "demo-user-not-found");
  if (status === "disabled" && user.role === "admin" && user.status === "active") {
    const activeAdmins = users.filter((candidate) => (
      candidate.role === "admin" && candidate.status === "active"
    )).length;
    if (activeAdmins <= 1) {
      throw new ClientApiError(
        409,
        "LAST_ACTIVE_ADMIN",
        "不能禁用最后一个有效管理员",
        "demo-last-active-admin",
      );
    }
  }
  user.status = status;
  return { ...user };
}

export function createDemoInvitation(
  expiresInHours: number,
  signal?: AbortSignal,
): CreatedInvitation {
  assertActive(signal);
  if (!Number.isSafeInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 168) {
    throw new ClientApiError(422, "VALIDATION_FAILED", "有效期必须是 1–168 之间的整数");
  }
  invitationSequence += 1;
  const token = `demo-admin-invitation-${invitationSequence}`;
  const origin = typeof window === "undefined" ? "https://fitgrid.demo" : window.location.origin;
  return {
    id: `00000000-0000-4000-8000-${String(invitationSequence).padStart(12, "0")}`,
    inviteUrl: new URL(withBasePath(`/invite/${token}`), origin).toString(),
    expiresAt: new Date(Date.UTC(2099, 0, 1, expiresInHours)).toISOString(),
  };
}
