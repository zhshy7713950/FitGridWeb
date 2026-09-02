import { requestJson } from "@/lib/api-client";

import type { CreatedInvitation, ManagedUser, ManagedUserPage } from "./types";

function isDevelopmentDemo(): boolean {
  return process.env.NODE_ENV !== "production"
    && process.env.NEXT_PUBLIC_UI_DEMO_MODE === "1";
}

export type ListUsersInput = {
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
};

export function listUsers(input: ListUsersInput = {}): Promise<ManagedUserPage> {
  if (isDevelopmentDemo()) {
    return import("./demo-admin-data").then((demo) => demo.listDemoUsers(input));
  }

  const query = new URLSearchParams();
  if (input.cursor !== undefined) query.set("cursor", input.cursor);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  const suffix = query.size ? `?${query.toString()}` : "";
  return requestJson<ManagedUserPage>(`/admin/users${suffix}`, { signal: input.signal });
}

export function updateUserStatus(
  userId: string,
  status: ManagedUser["status"],
  signal?: AbortSignal,
): Promise<ManagedUser> {
  if (isDevelopmentDemo()) {
    return import("./demo-admin-data").then((demo) => (
      demo.updateDemoUserStatus(userId, status, signal)
    ));
  }

  return requestJson<ManagedUser>(
    `/admin/users/${encodeURIComponent(userId)}/status`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
      signal,
    },
  );
}

export function createInvitation(
  expiresInHours: number,
  signal?: AbortSignal,
): Promise<CreatedInvitation> {
  if (isDevelopmentDemo()) {
    return import("./demo-admin-data").then((demo) => (
      demo.createDemoInvitation(expiresInHours, signal)
    ));
  }

  return requestJson<CreatedInvitation>(
    "/admin/invitations",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiresInHours }),
      signal,
    },
  );
}
