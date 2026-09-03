import { requestJson } from "@/lib/api-client";
import { isUiDemoMode } from "@/lib/ui-demo";

type DemoAccountData = typeof import("./demo-account-data");

const loadDemoAccountData = process.env.NODE_ENV === "production"
  ? null
  : () => import("./demo-account-data");

function demoAccountData(): Promise<DemoAccountData> {
  if (!loadDemoAccountData) {
    return Promise.reject(new Error("UI demo account data is unavailable in production"));
  }
  return loadDemoAccountData();
}

export function changePassword(
  currentPassword: string,
  newPassword: string,
  signal?: AbortSignal,
): Promise<void> {
  if (isUiDemoMode()) {
    return demoAccountData().then((demo) => (
      demo.changeDemoPassword(currentPassword, newPassword, signal)
    ));
  }

  return requestJson<void>(
    "/auth/change-password",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
      signal,
    },
    () => undefined,
  );
}
