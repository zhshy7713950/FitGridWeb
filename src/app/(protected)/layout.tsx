import { headers } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/app-shell";
import { ProtectedLoginRedirect } from "@/features/auth/protected-login-redirect";
import { isUiDemoMode, uiDemoUser } from "@/lib/ui-demo";
import { getOptionalSession } from "@/server/auth/session";

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const user = isUiDemoMode() ? uiDemoUser() : await getOptionalSession(await headers());
  if (!user) return <ProtectedLoginRedirect />;
  return <AppShell user={user}>{children}</AppShell>;
}
