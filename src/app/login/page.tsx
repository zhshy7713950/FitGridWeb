import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withBasePath } from "@/lib/app-paths";
import { getOptionalSession } from "@/server/auth/session";

export default async function LoginPage() {
  const user = await getOptionalSession(await headers());
  if (user) redirect(withBasePath("/grids"));
  return <main><h1>登录 FitGrid</h1></main>;
}
