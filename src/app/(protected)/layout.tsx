import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { protectedLoginRoute } from "@/features/auth/session-routing";
import { withBasePath } from "@/lib/app-paths";
import { getOptionalSession } from "@/server/auth/session";

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const user = await getOptionalSession(await headers());
  if (!user) redirect(withBasePath(protectedLoginRoute("/grids")));
  return <>{children}</>;
}
