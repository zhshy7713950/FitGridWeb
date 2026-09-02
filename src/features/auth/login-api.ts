import { ClientApiError, requestJson } from "@/lib/api-client";
import {
  isUiDemoMode,
  UI_DEMO_PASSWORD,
  UI_DEMO_USERNAME,
  uiDemoSession,
} from "@/lib/ui-demo";
import type { SessionResponse } from "./types";

export function login(username: string, password: string): Promise<SessionResponse> {
  if (isUiDemoMode()) {
    return username === UI_DEMO_USERNAME && password === UI_DEMO_PASSWORD
      ? Promise.resolve(uiDemoSession())
      : Promise.reject(new ClientApiError(401, "UNAUTHORIZED", "用户名或密码错误"));
  }

  return requestJson<SessionResponse>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export function logout(): Promise<void> {
  if (isUiDemoMode()) return Promise.resolve();
  return requestJson<void>("/auth/logout", { method: "POST" });
}
