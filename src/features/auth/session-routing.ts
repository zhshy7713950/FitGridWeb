import { loginRoute, type AppRoute } from "@/lib/app-paths";
import type { SessionUser } from "./types";

export function homeRoute(user: SessionUser | null): "/login" | "/grids" {
  return user ? "/grids" : "/login";
}

export function protectedLoginRoute(returnTo: string): AppRoute {
  return loginRoute(returnTo);
}
