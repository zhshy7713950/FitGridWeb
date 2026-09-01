export type AppBasePath = "" | "/fitgrid";
export type AppRoute = `/${string}`;
export type ApiRoute = `/${string}`;

const DEFAULT_ROUTE: AppRoute = "/grids";

export function browserBasePath(): AppBasePath {
  return process.env.NEXT_PUBLIC_APP_BASE_PATH === "/fitgrid" ? "/fitgrid" : "";
}

export function withBasePath(path: AppRoute, basePath: AppBasePath = browserBasePath()): string {
  return `${basePath}${path}`;
}

export function apiPath(path: ApiRoute, basePath: AppBasePath = browserBasePath()): string {
  return withBasePath(`/api/v1${path}`, basePath);
}

export function safeReturnPath(value: string | null | undefined): AppRoute {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return DEFAULT_ROUTE;
  }

  const parsed = new URL(value, "https://fitgrid.invalid");
  if (parsed.origin !== "https://fitgrid.invalid") return DEFAULT_ROUTE;
  if (parsed.pathname !== "/grids" && !parsed.pathname.startsWith("/grids/")) return DEFAULT_ROUTE;

  return `${parsed.pathname}${parsed.search}${parsed.hash}` as AppRoute;
}

export function loginRoute(returnTo: string | null | undefined): AppRoute {
  return `/login?returnTo=${encodeURIComponent(safeReturnPath(returnTo))}` as AppRoute;
}

export function unauthorizedRoute(
  visiblePath: string,
  basePath: AppBasePath = browserBasePath(),
): AppRoute {
  const appPath = basePath && visiblePath.startsWith(`${basePath}/`)
    ? visiblePath.slice(basePath.length)
    : visiblePath;
  return loginRoute(appPath);
}

export function browserUnauthorizedRedirect(): void {
  if (typeof window === "undefined") return;

  const basePath = browserBasePath();
  const visiblePath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.replace(withBasePath(unauthorizedRoute(visiblePath, basePath), basePath));
}
