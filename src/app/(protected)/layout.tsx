import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/app-shell";
import { protectedLoginRoute } from "@/features/auth/session-routing";
import { getOptionalSession } from "@/server/auth/session";

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const user = await getOptionalSession(await headers());
  if (!user) redirect(protectedLoginRoute("/grids"));
  return <AppShell user={user}>{children}</AppShell>;
}
