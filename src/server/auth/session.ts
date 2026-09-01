import type { FitGridAuth } from "./auth";
import { getAuth } from "./auth";
import { ApiError } from "@/server/http/api-error";

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: "member" | "admin";
  status: "active";
}

export async function requireSession(
  headers: Headers,
  auth: FitGridAuth = getAuth(),
): Promise<AuthenticatedUser> {
  const session = await auth.api.getSession({ headers });
  const user = session?.user as
    | { id: string; username?: string | null; name: string; role?: string; status?: string }
    | undefined;
  if (!user || user.status !== "active") {
    throw new ApiError(401, "UNAUTHORIZED", "未登录或会话已失效");
  }
  return {
    id: user.id,
    username: user.username ?? user.name,
    role: user.role === "admin" ? "admin" : "member",
    status: "active",
  };
}

export async function requireAdmin(
  headers: Headers,
  auth: FitGridAuth = getAuth(),
): Promise<AuthenticatedUser & { role: "admin" }> {
  const user = await requireSession(headers, auth);
  if (user.role !== "admin") {
    throw new ApiError(403, "FORBIDDEN", "需要管理员权限");
  }
  return { ...user, role: "admin" };
}
