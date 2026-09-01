import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { homeRoute } from "@/features/auth/session-routing";
import { getOptionalSession } from "@/server/auth/session";

export default async function HomePage() {
  const user = await getOptionalSession(await headers());
  redirect(homeRoute(user));
}
