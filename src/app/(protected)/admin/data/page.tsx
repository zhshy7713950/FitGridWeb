import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { DataManagementWorkspace } from "@/features/admin/data-management-workspace";
import { protectedLoginRoute } from "@/features/auth/session-routing";
import { isUiDemoMode, uiDemoUser } from "@/lib/ui-demo";
import { getOptionalSession } from "@/server/auth/session";

export default async function AdminDataPage() {
  const user = isUiDemoMode() ? uiDemoUser() : await getOptionalSession(await headers());
  if (!user) redirect(protectedLoginRoute("/admin/data"));
  if (user.role !== "admin") redirect("/grids");
  return <DataManagementWorkspace />;
}
