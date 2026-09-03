import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AdminWorkspace } from "@/features/admin/admin-workspace";
import { protectedLoginRoute } from "@/features/auth/session-routing";
import { isUiDemoMode, uiDemoUser } from "@/lib/ui-demo";
import { getOptionalSession } from "@/server/auth/session";

export default async function AdminPage() {
  const user = isUiDemoMode() ? uiDemoUser() : await getOptionalSession(await headers());
  if (!user) redirect(protectedLoginRoute("/admin"));
  if (user.role !== "admin") redirect("/grids");
  return <AdminWorkspace currentUserId={user.id} />;
}
