import type { SessionResponse, SessionUser } from "@/features/auth/types";

export const UI_DEMO_USERNAME = "demo";
export const UI_DEMO_PASSWORD = "fitgrid-demo";

export function isUiDemoMode(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_UI_DEMO_MODE === "1";
}

export function assertUiDemoConfiguration(
  nodeEnv = process.env.NODE_ENV,
  demoFlag = process.env.NEXT_PUBLIC_UI_DEMO_MODE,
): void {
  if (nodeEnv === "production" && demoFlag === "1") {
    throw new Error("UI demo mode is development-only");
  }
}

export function uiDemoUser(): SessionUser {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    username: UI_DEMO_USERNAME,
    role: "admin",
    status: "active",
  };
}

export function uiDemoSession(): SessionResponse {
  return {
    user: uiDemoUser(),
    expiresAt: "2099-12-31T23:59:59.000Z",
  };
}
