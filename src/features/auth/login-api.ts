import { requestJson } from "@/lib/api-client";
import type { SessionResponse } from "./types";

export function login(username: string, password: string): Promise<SessionResponse> {
  return requestJson<SessionResponse>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export function logout(): Promise<void> {
  return requestJson<void>("/auth/logout", { method: "POST" });
}
