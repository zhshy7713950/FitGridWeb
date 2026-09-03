import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { homeRoute } from "@/features/auth/session-routing";
import { isUiDemoMode, uiDemoUser } from "@/lib/ui-demo";
import { getOptionalSession } from "@/server/auth/session";

export default async function HomePage() {
  const user = isUiDemoMode() ? uiDemoUser() : await getOptionalSession(await headers());
  redirect(homeRoute(user));
}
