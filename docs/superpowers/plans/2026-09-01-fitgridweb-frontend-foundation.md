# FitGridWeb Frontend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved TradingView-style login flow, session-protected responsive application shell, and real searchable/paginated product list while preserving the existing single-image one-click production deployment.

**Architecture:** Keep the current Next.js modular monolith. Server components gate private routes with Better Auth database sessions; focused client components handle login, logout, and product-list interactions through the existing same-origin `/api/v1` endpoints. A pure base-path module and typed API client isolate deployment-path and error behavior from visual components.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5.9, Better Auth 1.7 database sessions, Vitest 4, jsdom, React Testing Library, CSS Modules, Docker Compose, GHCR, existing nginx `/fitgrid` deployment.

**Spec:** `docs/superpowers/specs/2026-09-01-fitgridweb-frontend-foundation-design.md`

## Global Constraints

- Production is compiled and served under the exact `basePath` `/fitgrid`; local development remains available at the root path.
- Authentication continues to use the existing Better Auth standard database session and secure `HttpOnly` cookie; client JavaScript never receives or stores a session token.
- The interface uses the approved TradingView-style token set: canvas `#0B0F14`, surface `#131722`, raised surface `#1E222D`, line `#2A2E39`, action `#2962FF`, positive `#089981`, negative `#F23645`, text `#D1D4DC`, muted text `#787B86`.
- Prices, amounts, product codes, and times use tabular/monospaced numerals and must never be converted through JavaScript floating-point arithmetic.
- Desktop and mobile expose the same product fields and actions; desktop uses a table and mobile uses data cards.
- Unimplemented create, detail, import, export, and admin actions do not appear as clickable placeholders.
- No new service, container, public port, runtime process, or nginx vhost is introduced.
- Existing sing-box configuration, subscription port `30127`, path `/s`, and subscription nginx vhost remain untouched.
- Every production behavior is implemented with a failing test first, then the smallest passing implementation, followed by refactoring while green.
- Each task receives an independent code review before the next task starts.

---

## File Structure

### Shared browser/server infrastructure

- `src/lib/app-paths.ts`: pure base-path joining and safe return-route validation.
- `src/lib/app-paths.test.ts`: local-root, `/fitgrid`, traversal/external-return, and API URL behavior.
- `src/lib/api-client.ts`: typed same-origin JSON request and normalized public errors.
- `src/lib/api-client.test.ts`: success, JSON error, non-JSON error, `Retry-After`, and no-content behavior.
- `src/test/setup.ts`: shared DOM matcher setup.
- `next.config.ts`: exposes the normalized build-time base path to the browser bundle.

### Authentication and routing

- `src/features/auth/types.ts`: public session/user response types.
- `src/features/auth/session-routing.ts`: pure session destination and login return-route helpers.
- `src/features/auth/session-routing.test.ts`: authenticated/anonymous and unsafe-return decisions.
- `src/features/auth/login-api.ts`: typed login/logout calls.
- `src/features/auth/login-form.tsx`: interactive username/password form.
- `src/features/auth/login-form.test.tsx`: login success, generic 401, rate limit, retry, and duplicate-submit behavior.
- `src/features/auth/login-brand.tsx`: decorative grid price-ladder brand panel.
- `src/features/auth/login.module.css`: approved login layout, tokens, animation, focus, and reduced motion.
- `src/server/auth/session.ts`: adds optional page-session lookup while retaining `requireSession` semantics.
- `src/server/auth/session.test.ts`: optional active/disabled/anonymous session cases.
- `src/app/page.tsx`: server-side root destination.
- `src/app/login/page.tsx`: public login page with logged-in redirect.
- `src/app/(protected)/layout.tsx`: server-side protected layout gate.

### Application shell

- `src/components/icons.tsx`: focused inline SVG icons added only when their destination ships; no icon runtime dependency.
- `src/components/app-shell/app-shell.tsx`: semantic desktop rail, account bar, mobile header/navigation, and content slot.
- `src/components/app-shell/app-shell.test.tsx`: navigation landmarks, current user, role, and content semantics.
- `src/components/app-shell/logout-button.tsx`: logout request state and redirect.
- `src/components/app-shell/logout-button.test.tsx`: logout success/failure/retry behavior.
- `src/components/app-shell/app-shell.module.css`: desktop, tablet, and mobile shell layout.

### Product list

- `src/features/grids/types.ts`: `GridTradeSummary`, `GridTradePage`, and list state contracts.
- `src/features/grids/grid-api.ts`: typed list request using `q`, `cursor`, and `limit=20`.
- `src/features/grids/grid-api.test.ts`: query encoding and response contract.
- `src/features/grids/use-grid-trades.ts`: 250ms search debounce, cancellation, refresh, cursor loading, and retry state.
- `src/features/grids/use-grid-trades.test.tsx`: initial load, stale search, clearing, paging, duplicate cursor, and retained-data errors.
- `src/features/grids/decimal-display.ts`: string-only grouping for decimal display.
- `src/features/grids/decimal-display.test.ts`: integer, fractional, negative, and large decimal formatting.
- `src/features/grids/grid-workspace.tsx`: toolbar, state messaging, table/cards, 240px load threshold, and keyboard load-more fallback.
- `src/features/grids/grid-workspace.test.tsx`: real visible behavior and identical field coverage in both renderers.
- `src/features/grids/grid-workspace.module.css`: dense desktop table and mobile cards.
- `src/app/(protected)/grids/page.tsx`: product workspace route.

### Global styling and release evidence

- `src/app/globals.css`: reset, tokens, typography, focus, reduced motion, and root canvas.
- `src/app/layout.tsx`: global stylesheet, metadata, viewport theme color, and Chinese document language.
- `docs/fit-replication/server-implementation-status.md`: records completed frontend evidence without changing server claims.
- `docs/fit-replication/low-memory-vps-runbook.md`: adds frontend smoke checks to the existing upgrade verification.

---

### Task 1: Base-Path and Typed Browser API Foundation

**Files:**
- Create: `src/lib/app-paths.ts`
- Create: `src/lib/app-paths.test.ts`
- Create: `src/lib/api-client.ts`
- Create: `src/lib/api-client.test.ts`
- Create: `src/test/setup.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `vitest.config.ts`
- Modify: `next.config.ts`

**Interfaces:**
- Produces: `withBasePath(path: AppRoute, basePath?: AppBasePath): string`
- Produces: `apiPath(path: ApiRoute, basePath?: AppBasePath): string`
- Produces: `safeReturnPath(value: string | null | undefined): AppRoute`
- Produces: `loginRoute(returnTo: string | null | undefined): AppRoute`
- Produces: `unauthorizedRoute(visiblePath: string, basePath?: AppBasePath): AppRoute`
- Produces: `requestJson<T>(path: ApiRoute, init?: RequestInit, onUnauthorized?: () => void): Promise<T>`
- Produces: `ClientApiError` with `status`, `code`, `requestId`, `fieldErrors`, and `retryAfterSeconds`.

- [ ] **Step 1: Install the DOM test dependencies used by all later component tasks**

Run:

```bash
pnpm add -D jsdom @testing-library/dom @testing-library/jest-dom @testing-library/react @testing-library/user-event
```

Add `src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

Set the existing Vitest configuration to keep server tests in Node while loading the matchers everywhere:

```ts
test: {
  environment: "node",
  setupFiles: ["./src/test/setup.ts"],
  coverage: { reporter: ["text", "json", "html"] },
},
```

- [ ] **Step 2: Write failing path-contract tests**

Create `src/lib/app-paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { apiPath, loginRoute, safeReturnPath, unauthorizedRoute, withBasePath } from "./app-paths";

describe("application paths", () => {
  it("joins local and production paths without duplicate slashes", () => {
    expect(withBasePath("/login", "")).toBe("/login");
    expect(withBasePath("/login", "/fitgrid")).toBe("/fitgrid/login");
    expect(apiPath("/auth/login", "/fitgrid")).toBe("/fitgrid/api/v1/auth/login");
  });

  it.each([null, "", "//evil.example", "https://evil.example", "/admin", "/grids\\evil"])(
    "falls back from unsafe return path %s",
    (value) => expect(safeReturnPath(value)).toBe("/grids"),
  );

  it("keeps the grids route, query, and hash", () => {
    expect(safeReturnPath("/grids/abc?q=gold#row-2")).toBe("/grids/abc?q=gold#row-2");
    expect(loginRoute("/grids?q=gold")).toBe("/login?returnTo=%2Fgrids%3Fq%3Dgold");
    expect(unauthorizedRoute("/fitgrid/grids?q=gold", "/fitgrid")).toBe("/login?returnTo=%2Fgrids%3Fq%3Dgold");
  });
});
```

- [ ] **Step 3: Run the path test and confirm the red state**

Run:

```bash
pnpm vitest run src/lib/app-paths.test.ts
```

Expected: FAIL because `src/lib/app-paths.ts` and its exports do not exist.

- [ ] **Step 4: Implement the pure path functions and expose the build path**

Create `src/lib/app-paths.ts`:

```ts
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
```

Update `next.config.ts` after computing the normalized `basePath` once:

```ts
const basePath = normalizeBasePath(process.env.NEXT_BASE_PATH);

const nextConfig: NextConfig = {
  basePath,
  env: { NEXT_PUBLIC_APP_BASE_PATH: basePath },
  output: "standalone",
};
```

- [ ] **Step 5: Re-run the path test and confirm green**

Run:

```bash
pnpm vitest run src/lib/app-paths.test.ts
```

Expected: PASS with 3 path behaviors covered.

- [ ] **Step 6: Write failing API-client behavior tests**

Create `src/lib/api-client.test.ts` with a real `Response` boundary and only mock the external `fetch` call:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientApiError, requestJson } from "./api-client";

afterEach(() => vi.unstubAllGlobals());

describe("requestJson", () => {
  it("returns JSON from a same-origin API request", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status: "ok" }));
    vi.stubGlobal("fetch", fetcher);
    await expect(requestJson<{ status: string }>("/health")).resolves.toEqual({ status: "ok" });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/health", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("normalizes the public error envelope and Retry-After", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { code: "RATE_LIMITED", message: "请求过快", requestId: "01REQ" },
      { status: 429, headers: { "Retry-After": "37" } },
    )));
    await expect(requestJson("/auth/login")).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      requestId: "01REQ",
      retryAfterSeconds: 37,
    });
  });

  it("accepts an empty 204 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(requestJson<void>("/auth/logout", { method: "POST" })).resolves.toBeUndefined();
  });

  it("invokes the session-expiry boundary for non-login 401 responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { code: "UNAUTHORIZED", message: "未登录或会话已失效" },
      { status: 401 },
    )));
    const onUnauthorized = vi.fn();
    await expect(requestJson("/grid-trades", {}, onUnauthorized)).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 7: Run the API-client test and confirm the red state**

Run:

```bash
pnpm vitest run src/lib/api-client.test.ts
```

Expected: FAIL because `ClientApiError` and `requestJson` do not exist.

- [ ] **Step 8: Implement the API client**

Create `src/lib/api-client.ts`:

```ts
import { apiPath, browserUnauthorizedRedirect, type ApiRoute } from "./app-paths";

export type FieldErrors = Record<string, string[]>;

export class ClientApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly fieldErrors?: FieldErrors,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ClientApiError";
  }
}

export async function requestJson<T>(
  path: ApiRoute,
  init: RequestInit = {},
  onUnauthorized: () => void = browserUnauthorizedRedirect,
): Promise<T> {
  const response = await fetch(apiPath(path), {
    ...init,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...init.headers },
  });
  if (response.ok) {
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
  if (response.status === 401 && path !== "/auth/login") onUnauthorized();
  const body = await response.json().catch(() => ({})) as Partial<{
    code: string; message: string; requestId: string; fieldErrors: FieldErrors;
  }>;
  const retry = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
  throw new ClientApiError(
    response.status,
    body.code ?? "REQUEST_FAILED",
    body.message ?? "请求失败",
    body.requestId,
    body.fieldErrors,
    Number.isFinite(retry) && retry > 0 ? retry : undefined,
  );
}
```

- [ ] **Step 9: Verify Task 1 and commit**

Run:

```bash
pnpm vitest run src/lib/app-paths.test.ts src/lib/api-client.test.ts
pnpm typecheck
```

Expected: all new tests pass and TypeScript exits 0.

Commit:

```bash
git add package.json pnpm-lock.yaml vitest.config.ts next.config.ts src/test/setup.ts src/lib/app-paths.ts src/lib/app-paths.test.ts src/lib/api-client.ts src/lib/api-client.test.ts
git commit -m "feat: add frontend path and api foundations"
```

---

### Task 2: Session-Aware Routes and Protected Boundary

**Files:**
- Create: `src/features/auth/types.ts`
- Create: `src/features/auth/session-routing.ts`
- Create: `src/features/auth/session-routing.test.ts`
- Create: `src/app/login/page.tsx`
- Create: `src/app/(protected)/layout.tsx`
- Modify: `src/server/auth/session.ts`
- Modify: `src/server/auth/session.test.ts`
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: `safeReturnPath`, `withBasePath` from Task 1.
- Produces: `SessionUser`, `SessionResponse`.
- Produces: `getOptionalSession(headers: Headers, auth?: FitGridAuth): Promise<AuthenticatedUser | null>`.
- Produces: `homeRoute(user: SessionUser | null): "/login" | "/grids"`.
- Produces: `protectedLoginRoute(returnTo: string): string`.

- [ ] **Step 1: Write failing session-routing tests**

Create `src/features/auth/session-routing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { homeRoute, protectedLoginRoute } from "./session-routing";

describe("session page routing", () => {
  it("routes anonymous visitors to login and active users to grids", () => {
    expect(homeRoute(null)).toBe("/login");
    expect(homeRoute({ id: "u1", username: "admin", role: "admin", status: "active" })).toBe("/grids");
  });

  it("encodes only a safe application return route", () => {
    expect(protectedLoginRoute("/grids/abc?q=gold")).toBe("/login?returnTo=%2Fgrids%2Fabc%3Fq%3Dgold");
    expect(protectedLoginRoute("https://evil.example")).toBe("/login?returnTo=%2Fgrids");
  });
});
```

- [ ] **Step 2: Add an expected failing case for optional sessions**

Extend the existing import with `getOptionalSession`, then add these cases using the file's existing `authWith` fake:

```ts
it("returns null instead of throwing for a missing page session", async () => {
  const auth = authWith();
  await expect(getOptionalSession(new Headers(), auth)).resolves.toBeNull();
});

it("returns null for a disabled page session", async () => {
  const auth = authWith({ id: "u1", name: "admin", role: "admin", status: "disabled" });
  await expect(getOptionalSession(new Headers(), auth)).resolves.toBeNull();
});
```

- [ ] **Step 3: Run the two test files and confirm red**

Run:

```bash
pnpm vitest run src/features/auth/session-routing.test.ts src/server/auth/session.test.ts
```

Expected: FAIL because the route helpers and `getOptionalSession` are missing.

- [ ] **Step 4: Implement public auth types and routing decisions**

Create `src/features/auth/types.ts`:

```ts
export interface SessionUser {
  id: string;
  username: string;
  role: "member" | "admin";
  status: "active";
}

export interface SessionResponse {
  user: SessionUser;
  expiresAt: string;
}
```

Create `src/features/auth/session-routing.ts`:

```ts
import { loginRoute, type AppRoute } from "@/lib/app-paths";
import type { SessionUser } from "./types";

export function homeRoute(user: SessionUser | null): "/login" | "/grids" {
  return user ? "/grids" : "/login";
}

export function protectedLoginRoute(returnTo: string): AppRoute {
  return loginRoute(returnTo);
}
```

Refactor `src/server/auth/session.ts` so `getOptionalSession` contains the single Better Auth lookup and `requireSession` wraps it:

```ts
export async function getOptionalSession(
  headers: Headers,
  auth: FitGridAuth = getAuth(),
): Promise<AuthenticatedUser | null> {
  const session = await auth.api.getSession({ headers });
  const user = session?.user as
    | { id: string; username?: string | null; name: string; role?: string; status?: string }
    | undefined;
  if (!user || user.status !== "active") return null;
  return {
    id: user.id,
    username: user.username ?? user.name,
    role: user.role === "admin" ? "admin" : "member",
    status: "active",
  };
}

export async function requireSession(headers: Headers, auth: FitGridAuth = getAuth()) {
  const user = await getOptionalSession(headers, auth);
  if (!user) throw new ApiError(401, "UNAUTHORIZED", "未登录或会话已失效");
  return user;
}
```

- [ ] **Step 5: Implement the server route boundaries**

Replace `src/app/page.tsx` with a server redirect based on the optional session:

```tsx
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { homeRoute } from "@/features/auth/session-routing";
import { withBasePath } from "@/lib/app-paths";
import { getOptionalSession } from "@/server/auth/session";

export default async function HomePage() {
  const user = await getOptionalSession(await headers());
  redirect(withBasePath(homeRoute(user)));
}
```

Create `src/app/(protected)/layout.tsx`:

```tsx
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
```

Create a temporary server login route that will compose the tested client form in Task 3:

```tsx
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withBasePath } from "@/lib/app-paths";
import { getOptionalSession } from "@/server/auth/session";

export default async function LoginPage() {
  const user = await getOptionalSession(await headers());
  if (user) redirect(withBasePath("/grids"));
  return <main><h1>登录 FitGrid</h1></main>;
}
```

- [ ] **Step 6: Verify Task 2 and commit**

Run:

```bash
pnpm vitest run src/features/auth/session-routing.test.ts src/server/auth/session.test.ts
pnpm typecheck
```

Expected: tests pass and page modules type-check.

Commit:

```bash
git add src/features/auth/types.ts src/features/auth/session-routing.ts src/features/auth/session-routing.test.ts src/server/auth/session.ts src/server/auth/session.test.ts src/app/page.tsx src/app/login/page.tsx 'src/app/(protected)/layout.tsx'
git commit -m "feat: add session-aware frontend routes"
```

---

### Task 3: TradingView-Style Login Experience

**Files:**
- Create: `src/features/auth/login-api.ts`
- Create: `src/features/auth/login-form.tsx`
- Create: `src/features/auth/login-form.test.tsx`
- Create: `src/features/auth/login-brand.tsx`
- Create: `src/features/auth/login.module.css`
- Create: `src/app/globals.css`
- Modify: `src/app/login/page.tsx`
- Modify: `src/app/layout.tsx`

**Interfaces:**
- Consumes: `requestJson`, `ClientApiError`, `safeReturnPath`, and `withBasePath` from Task 1.
- Consumes: `SessionResponse` from Task 2.
- Produces: `login(username: string, password: string): Promise<SessionResponse>`.
- Produces: `logout(): Promise<void>` for Task 4.
- Produces: `LoginForm({ returnTo, request?, navigate? })` with injectable external boundaries for real behavior tests.

- [ ] **Step 1: Write failing login-form tests**

Create `src/features/auth/login-form.test.tsx` with `// @vitest-environment jsdom` at the top:

```tsx
// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClientApiError } from "@/lib/api-client";
import { LoginForm } from "./login-form";

const session = {
  user: { id: "u1", username: "admin", role: "admin" as const, status: "active" as const },
  expiresAt: "2026-09-08T00:00:00.000Z",
};

describe("LoginForm", () => {
  it("logs in and replaces the page with the safe return route", async () => {
    const request = vi.fn().mockResolvedValue(session);
    const navigate = vi.fn();
    render(<LoginForm returnTo="/grids?q=gold" request={request} navigate={navigate} />);
    await userEvent.type(screen.getByLabelText("用户名"), "admin");
    await userEvent.type(screen.getByLabelText("密码"), "long-password");
    await userEvent.click(screen.getByRole("button", { name: "登录工作台" }));
    expect(request).toHaveBeenCalledWith("admin", "long-password");
    expect(navigate).toHaveBeenCalledWith("/grids?q=gold");
  });

  it("uses one generic message for a 401 and retains only the username", async () => {
    const request = vi.fn().mockRejectedValue(new ClientApiError(401, "UNAUTHORIZED", "用户名或密码错误"));
    render(<LoginForm returnTo="/grids" request={request} navigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("用户名"), "admin");
    await userEvent.type(screen.getByLabelText("密码"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "登录工作台" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("用户名或密码错误");
    expect(screen.getByLabelText("用户名")).toHaveValue("admin");
    expect(screen.getByLabelText("密码")).toHaveValue("");
  });

  it("associates 422 field errors with the corresponding controls", async () => {
    const request = vi.fn().mockRejectedValue(new ClientApiError(
      422,
      "VALIDATION_ERROR",
      "请求参数校验失败",
      "01FIELD",
      { username: ["用户名不能为空"], password: ["密码长度不符合要求"] },
    ));
    render(<LoginForm returnTo="/grids" request={request} navigate={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "登录工作台" }));
    expect(await screen.findByText("用户名不能为空")).toHaveAttribute("id", "username-error");
    expect(screen.getByLabelText("用户名")).toHaveAttribute("aria-describedby", "username-error");
    expect(screen.getByText("密码长度不符合要求")).toHaveAttribute("id", "password-error");
  });

  it("shows the server rate-limit countdown", async () => {
    const request = vi.fn().mockRejectedValue(new ClientApiError(429, "RATE_LIMITED", "请求过快", "01REQ", undefined, 37));
    render(<LoginForm returnTo="/grids" request={request} navigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("用户名"), "admin");
    await userEvent.type(screen.getByLabelText("密码"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "登录工作台" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请求过快，37 秒后重试");
  });

  it("prevents duplicate submission while the first request is pending", async () => {
    let resolve!: (value: typeof session) => void;
    const request = vi.fn(() => new Promise<typeof session>((done) => { resolve = done; }));
    render(<LoginForm returnTo="/grids" request={request} navigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("用户名"), "admin");
    await userEvent.type(screen.getByLabelText("密码"), "long-password");
    const button = screen.getByRole("button", { name: "登录工作台" });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(session); });
  });

  it("keeps the username and allows retry after a network failure", async () => {
    const request = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(session);
    const navigate = vi.fn();
    render(<LoginForm returnTo="/grids" request={request} navigate={navigate} />);
    await userEvent.type(screen.getByLabelText("用户名"), "admin");
    await userEvent.type(screen.getByLabelText("密码"), "long-password");
    await userEvent.click(screen.getByRole("button", { name: "登录工作台" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("网络连接失败，请重试");
    expect(screen.getByLabelText("用户名")).toHaveValue("admin");
    await userEvent.type(screen.getByLabelText("密码"), "long-password");
    await userEvent.click(screen.getByRole("button", { name: "登录工作台" }));
    expect(navigate).toHaveBeenCalledWith("/grids");
  });
});
```

- [ ] **Step 2: Run the login-form test and confirm red**

Run:

```bash
pnpm vitest run src/features/auth/login-form.test.tsx
```

Expected: FAIL because the login form and API module do not exist.

- [ ] **Step 3: Implement the login/logout API boundary**

Create `src/features/auth/login-api.ts`:

```ts
import { requestJson } from "@/lib/api-client";
import type { SessionResponse } from "./types";

export function login(username: string, password: string): Promise<SessionResponse> {
  return requestJson<SessionResponse>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export function logout(): Promise<void> {
  return requestJson<void>("/auth/logout", { method: "POST" });
}
```

- [ ] **Step 4: Implement the tested login state machine**

Create `src/features/auth/login-form.tsx` as a client component with these exact public boundaries:

```tsx
"use client";
import { useEffect, useState, type FormEvent } from "react";
import { ClientApiError } from "@/lib/api-client";
import { safeReturnPath, withBasePath } from "@/lib/app-paths";
import { login } from "./login-api";
import styles from "./login.module.css";

type LoginRequest = typeof login;
type Navigate = (path: string) => void;

export function LoginForm({
  returnTo,
  request = login,
  navigate = (path) => window.location.replace(withBasePath(path as `/${string}`)),
}: { returnTo: string; request?: LoginRequest; navigate?: Navigate }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [retryAfter, setRetryAfter] = useState(0);

  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = window.setTimeout(() => {
      const next = retryAfter - 1;
      setRetryAfter(next);
      if (next === 0) setError("");
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [retryAfter]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || retryAfter > 0) return;
    setPending(true);
    setError("");
    setFieldErrors({});
    try {
      await request(username, password);
      navigate(safeReturnPath(returnTo));
    } catch (caught) {
      setPassword("");
      if (caught instanceof ClientApiError && caught.status === 422) {
        setFieldErrors(caught.fieldErrors ?? {});
        setError("请检查标记字段");
      } else if (caught instanceof ClientApiError && caught.status === 429) {
        const seconds = caught.retryAfterSeconds ?? 1;
        setRetryAfter(seconds);
        setError(caught.message);
      } else if (caught instanceof ClientApiError && caught.status === 401) {
        setError("用户名或密码错误");
      } else {
        setError(caught instanceof ClientApiError && caught.requestId
          ? `服务暂时不可用，请求 ID：${caught.requestId}`
          : "网络连接失败，请重试");
      }
    } finally {
      setPending(false);
    }
  }

  return <form className={styles.form} onSubmit={submit} noValidate>
    <label className={styles.field}>用户名<input name="username" autoComplete="username" aria-invalid={!!fieldErrors.username} aria-describedby={fieldErrors.username ? "username-error" : undefined} value={username} onChange={(event) => setUsername(event.target.value)} />{fieldErrors.username && <span id="username-error">{fieldErrors.username[0]}</span>}</label>
    <label className={styles.field}>密码<input name="password" type="password" autoComplete="current-password" aria-invalid={!!fieldErrors.password} aria-describedby={fieldErrors.password ? "password-error" : undefined} value={password} onChange={(event) => setPassword(event.target.value)} />{fieldErrors.password && <span id="password-error">{fieldErrors.password[0]}</span>}</label>
    {error && <p className={styles.error} role="alert">{retryAfter > 0 ? `${error}，${retryAfter} 秒后重试` : error}</p>}
    <button className={styles.submit} disabled={pending || retryAfter > 0}>{pending ? "正在登录…" : "登录工作台"}</button>
  </form>;
}
```

- [ ] **Step 5: Re-run login behavior tests and confirm green**

Run:

```bash
pnpm vitest run src/features/auth/login-form.test.tsx
```

Expected: all six login behaviors pass.

- [ ] **Step 6: Build the approved visual system without adding new behavior**

Create `src/app/globals.css` with the approved variables and global behavior:

```css
:root {
  --canvas: #0b0f14; --surface: #131722; --surface-raised: #1e222d;
  --line: #2a2e39; --action: #2962ff; --positive: #089981;
  --negative: #f23645; --text: #d1d4dc; --text-muted: #787b86;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { min-height: 100%; }
body { margin: 0; color: var(--text); background: var(--canvas); font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
button, input { font: inherit; }
:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; box-shadow: 0 0 0 4px var(--canvas); }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; } }
```

Create `src/features/auth/login-brand.tsx`:

```tsx
import styles from "./login.module.css";

export function LoginBrand() {
  return <aside className={styles.brand}>
    <div className={styles.wordmark}><span>FG</span> FitGrid</div>
    <svg className={styles.ladder} viewBox="0 0 520 240" aria-hidden="true">
      <g className={styles.gridLines}>
        <path d="M0 40H520M0 90H520M0 140H520M0 190H520" />
        <path d="M40 0V240M120 0V240M200 0V240M280 0V240M360 0V240M440 0V240" />
      </g>
      <path className={styles.stepLine} d="M32 48H150V94H270V142H390V190H488" />
      <g className={styles.nodes}><circle cx="150" cy="48" r="6"/><circle cx="270" cy="94" r="6"/><circle cx="390" cy="142" r="6"/><circle cx="488" cy="190" r="6"/></g>
    </svg>
    <p className={styles.eyebrow}>Rule-based strategy workspace</p>
    <h1>让每一道网格<br />都有清晰依据</h1>
    <p className={styles.brandCopy}>集中管理参数、档位与计算结果，只保留对策略决策有用的信息。</p>
  </aside>;
}
```

Create `src/features/auth/login.module.css` with these concrete layout and motion rules, then add field/button/error selectors used by `LoginForm`:

```css
.page { min-height: 100dvh; display: grid; place-items: center; padding: 32px; background: var(--canvas); }
.loginCard { width: min(1040px, 100%); min-height: 620px; display: grid; grid-template-columns: 1.2fr .8fr; overflow: hidden; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.brand { position: relative; display: flex; flex-direction: column; justify-content: flex-end; overflow: hidden; padding: 48px; border-right: 1px solid var(--line); }
.wordmark { position: absolute; top: 32px; left: 40px; display: flex; align-items: center; gap: 10px; font-weight: 700; }
.wordmark span { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 6px; color: white; background: var(--action); font-size: 11px; }
.ladder { position: absolute; inset: 72px 24px auto; width: calc(100% - 48px); color: var(--action); }
.gridLines { fill: none; stroke: var(--line); stroke-width: 1; opacity: .55; }
.stepLine { fill: none; stroke: currentColor; stroke-width: 3; stroke-linejoin: round; stroke-dasharray: 900; animation: draw-ladder 600ms ease-out both; }
.nodes { fill: #6e91ff; stroke: var(--surface); stroke-width: 4; }
.eyebrow { margin: 0 0 10px; color: var(--text-muted); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; }
.brand h1 { margin: 0; font-size: clamp(32px, 4vw, 52px); line-height: 1.08; letter-spacing: -.045em; }
.brandCopy { max-width: 460px; margin: 18px 0 0; color: var(--text-muted); line-height: 1.7; }
.panel { display: flex; flex-direction: column; justify-content: center; padding: 48px; animation: panel-in 600ms ease-out both; }
.panel h2 { margin: 0 0 8px; font-size: 24px; }
.panelIntro { margin: 0 0 28px; color: var(--text-muted); }
.form { display: grid; gap: 18px; }
.field { display: grid; gap: 8px; color: var(--text-muted); font-size: 13px; }
.field input { min-height: 44px; padding: 0 13px; border: 1px solid var(--line); border-radius: 5px; color: var(--text); background: var(--canvas); }
.field input:focus { border-color: var(--action); }
.field span { color: #ff7b84; font-size: 12px; }
.submit { min-height: 44px; border: 0; border-radius: 5px; color: white; background: var(--action); font-weight: 700; cursor: pointer; }
.submit:disabled { cursor: not-allowed; opacity: .55; }
.error { margin: 0; color: #ff7b84; font-size: 13px; line-height: 1.5; }
@keyframes draw-ladder { from { stroke-dashoffset: 900; opacity: .2; } to { stroke-dashoffset: 0; opacity: 1; } }
@keyframes panel-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@media (max-width: 767px) { .page { padding: 0; } .loginCard { min-height: 100dvh; grid-template-columns: 1fr; border: 0; border-radius: 0; } .brand { min-height: 310px; padding: 32px 24px; border-right: 0; border-bottom: 1px solid var(--line); } .panel { padding: 32px 24px 48px; } .ladder { top: 54px; } }
```

Update the `LoginForm` JSX to bind `.field`, `.submit`, and `.error` rather than leaving unstyled native elements.

Update `src/app/layout.tsx`:

```tsx
import "./globals.css";
export const metadata = { title: "FitGrid 策略工作台", description: "私有网格策略计算与管理" };
export const viewport = { themeColor: "#0B0F14", colorScheme: "dark" };
```

Compose `LoginBrand` and `LoginForm` in `src/app/login/page.tsx` with the Next 16 asynchronous search-parameter contract:

```tsx
export default async function LoginPage({ searchParams }: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const user = await getOptionalSession(await headers());
  if (user) redirect(withBasePath("/grids"));
  const raw = (await searchParams).returnTo;
  const returnTo = safeReturnPath(Array.isArray(raw) ? raw[0] : raw);
  return <main className={styles.page}>
    <div className={styles.loginCard}>
      <LoginBrand />
      <section className={styles.panel} aria-labelledby="login-title">
        <h2 id="login-title">登录工作台</h2>
        <p className={styles.panelIntro}>使用受邀账户进入你的网格策略空间。</p>
        <LoginForm returnTo={returnTo} />
      </section>
    </div>
  </main>;
}
```

- [ ] **Step 7: Verify Task 3 and commit**

Run:

```bash
pnpm vitest run src/features/auth/login-form.test.tsx src/lib/app-paths.test.ts src/lib/api-client.test.ts
pnpm typecheck
pnpm lint
```

Commit:

```bash
git add src/app/globals.css src/app/layout.tsx src/app/login/page.tsx src/features/auth/login-api.ts src/features/auth/login-form.tsx src/features/auth/login-form.test.tsx src/features/auth/login-brand.tsx src/features/auth/login.module.css
git commit -m "feat: add trading workspace login"
```

---

### Task 4: Responsive Protected App Shell and Logout

**Files:**
- Create: `src/components/icons.tsx`
- Create: `src/components/app-shell/app-shell.tsx`
- Create: `src/components/app-shell/app-shell.test.tsx`
- Create: `src/components/app-shell/logout-button.tsx`
- Create: `src/components/app-shell/logout-button.test.tsx`
- Create: `src/components/app-shell/app-shell.module.css`
- Modify: `src/app/(protected)/layout.tsx`

**Interfaces:**
- Consumes: `SessionUser` and `logout` from earlier tasks.
- Produces: `AppShell({ user, children })`.
- Produces: `LogoutButton({ request?, navigate? })`.

- [ ] **Step 1: Write failing semantic shell and logout tests**

Create `src/components/app-shell/app-shell.test.tsx` with jsdom:

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell";

it("exposes one application navigation and the current account", () => {
  render(<AppShell user={{ id: "u1", username: "admin", role: "admin", status: "active" }}><h1>网格产品</h1></AppShell>);
  expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
  expect(screen.getByRole("main")).toHaveTextContent("网格产品");
  expect(screen.getByText("admin")).toBeInTheDocument();
  expect(screen.getByText("管理员")).toBeInTheDocument();
  expect(screen.queryByText("导入")).not.toBeInTheDocument();
});
```

Create `src/components/app-shell/logout-button.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { LogoutButton } from "./logout-button";

it("deletes the session then replaces the page with login", async () => {
  const request = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn();
  render(<LogoutButton request={request} navigate={navigate} />);
  await userEvent.click(screen.getByRole("button", { name: "退出登录" }));
  expect(request).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith("/login");
});

it("keeps the user in place and offers retry after failure", async () => {
  const request = vi.fn().mockRejectedValue(new Error("offline"));
  render(<LogoutButton request={request} navigate={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "退出登录" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("退出失败，请重试");
});
```

- [ ] **Step 2: Run the shell tests and confirm red**

Run:

```bash
pnpm vitest run src/components/app-shell/app-shell.test.tsx src/components/app-shell/logout-button.test.tsx
```

Expected: FAIL because the shell and logout components do not exist.

- [ ] **Step 3: Implement logout state and navigation**

Create `logout-button.tsx`:

```tsx
"use client";
import { useState } from "react";
import { logout } from "@/features/auth/login-api";
import { withBasePath } from "@/lib/app-paths";
import styles from "./app-shell.module.css";

export function LogoutButton({
  request = logout,
  navigate = (path) => window.location.replace(withBasePath(path as `/${string}`)),
}: { request?: typeof logout; navigate?: (path: string) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function leave() {
    if (pending) return;
    setPending(true); setError("");
    try { await request(); navigate("/login"); }
    catch { setError("退出失败，请重试"); }
    finally { setPending(false); }
  }
  return <div className={styles.logoutArea}>
    <button className={styles.logout} disabled={pending} onClick={leave}>{pending ? "正在退出…" : "退出登录"}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
```

- [ ] **Step 4: Implement the semantic responsive shell**

Create the inline SVG component used by the current navigation in `src/components/icons.tsx`; add later icons only when their destination ships:

```tsx
import type { SVGProps } from "react";
export function GridIcon(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" {...props}>
    <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
    <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
  </svg>;
}
```

Create `app-shell.tsx`:

```tsx
import type { ReactNode } from "react";
import Link from "next/link";
import type { SessionUser } from "@/features/auth/types";
import { GridIcon } from "@/components/icons";
import { LogoutButton } from "./logout-button";
import styles from "./app-shell.module.css";

export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }) {
  return <div className={styles.shell}>
    <nav aria-label="主导航" className={styles.rail}>
      <div className={styles.logo} aria-label="FitGrid">FG</div>
      <Link href="/grids" aria-current="page"><GridIcon /> <span>网格产品</span></Link>
    </nav>
    <header className={styles.accountBar}>
      <span className={styles.mobileBrand}>FitGrid</span>
      <span className={styles.connection}>安全连接</span>
      <span>{user.username}</span>
      <span>{user.role === "admin" ? "管理员" : "普通用户"}</span>
      <LogoutButton />
    </header>
    <main className={styles.content}>{children}</main>
  </div>;
}
```

Create `app-shell.module.css`:

```css
.shell { min-height: 100dvh; display: grid; grid-template: 44px 1fr / 176px 1fr; background: var(--canvas); }
.rail { grid-row: 1 / 3; display: flex; flex-direction: column; gap: 8px; padding: 12px 10px; border-right: 1px solid var(--line); background: #0d141d; }
.logo { display: grid; place-items: center; width: 32px; height: 32px; margin: 0 8px 20px; border-radius: 6px; color: white; background: var(--action); font-size: 11px; font-weight: 800; }
.rail a { min-height: 44px; display: flex; align-items: center; gap: 10px; padding: 0 11px; border-radius: 5px; color: var(--text); text-decoration: none; background: var(--surface-raised); }
.rail svg { width: 18px; height: 18px; flex: 0 0 auto; }
.accountBar { grid-column: 2; display: flex; align-items: center; justify-content: flex-end; gap: 14px; padding: 0 18px; border-bottom: 1px solid var(--line); color: var(--text-muted); background: var(--surface); font-size: 12px; }
.mobileBrand { display: none; color: var(--text); font-weight: 750; }
.connection::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: var(--positive); }
.content { min-width: 0; overflow: auto; padding: 24px; }
.logoutArea { position: relative; }
.logout { min-height: 32px; padding: 0 10px; border: 1px solid var(--line); border-radius: 4px; color: var(--text); background: transparent; }
.logoutArea p { position: absolute; right: 0; top: 34px; width: max-content; margin: 0; padding: 7px 9px; border: 1px solid var(--negative); color: #ff7b84; background: var(--surface-raised); }
@media (max-width: 1023px) { .shell { grid-template-columns: 56px 1fr; } .rail { align-items: center; padding-inline: 6px; } .rail a { width: 44px; justify-content: center; padding: 0; } .rail a span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); } .logo { margin-inline: 0; } }
@media (max-width: 767px) { .shell { grid-template: 48px 1fr 56px / 1fr; } .accountBar { grid-column: 1; grid-row: 1; justify-content: space-between; padding-inline: 12px; } .mobileBrand { display: inline; } .connection { display: none; } .rail { grid-column: 1; grid-row: 3; flex-direction: row; justify-content: center; padding: 6px; border: 1px solid var(--line); border-width: 1px 0 0; } .rail .logo { display: none; } .rail a { width: auto; min-width: 96px; padding: 0 14px; } .rail a span { position: static; width: auto; height: auto; overflow: visible; clip: auto; } .content { grid-row: 2; padding: 16px 12px; } }
```

Update the protected layout to render `<AppShell user={user}>{children}</AppShell>` after its existing session gate.

- [ ] **Step 5: Verify Task 4 and commit**

Run:

```bash
pnpm vitest run src/components/app-shell/app-shell.test.tsx src/components/app-shell/logout-button.test.tsx
pnpm typecheck
pnpm lint
```

Commit:

```bash
git add src/components/icons.tsx src/components/app-shell 'src/app/(protected)/layout.tsx'
git commit -m "feat: add responsive authenticated shell"
```

---

### Task 5: Product List Data Model, Search, Cancellation, and Pagination

**Files:**
- Create: `src/features/grids/types.ts`
- Create: `src/features/grids/grid-api.ts`
- Create: `src/features/grids/grid-api.test.ts`
- Create: `src/features/grids/use-grid-trades.ts`
- Create: `src/features/grids/use-grid-trades.test.tsx`
- Create: `src/features/grids/decimal-display.ts`
- Create: `src/features/grids/decimal-display.test.ts`

**Interfaces:**
- Consumes: `requestJson` and `ClientApiError`.
- Produces: `GridTradeSummary`, `GridTradePage`.
- Produces: `listGridTrades({ q, cursor, signal }): Promise<GridTradePage>`.
- Produces: `useGridTrades({ request? }): GridTradeListController`.
- Produces: `formatDecimal(value: string): string` without `Number` or `parseFloat`.

- [ ] **Step 1: Write failing API and decimal tests**

Create `src/features/grids/grid-api.test.ts`:

```ts
import { afterEach, expect, it, vi } from "vitest";
import { listGridTrades } from "./grid-api";

afterEach(() => vi.unstubAllGlobals());

it("encodes q, cursor, and the fixed 20-item limit", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ items: [], nextCursor: null }));
  vi.stubGlobal("fetch", fetcher);
  await listGridTrades({ q: "黄金 ETF", cursor: "signed+cursor" });
  expect(fetcher.mock.calls[0][0]).toBe("/api/v1/grid-trades?q=%E9%BB%84%E9%87%91+ETF&cursor=signed%2Bcursor&limit=20");
});
```

Create `src/features/grids/decimal-display.test.ts`:

```ts
import { expect, it } from "vitest";
import { formatDecimal } from "./decimal-display";

it.each([
  ["2000", "2,000"], ["12345678901234567890.5000", "12,345,678,901,234,567,890.5000"],
  ["-1200.05", "-1,200.05"], ["0.9400", "0.9400"],
])("formats %s without losing decimal text", (value, expected) => {
  expect(formatDecimal(value)).toBe(expected);
});
```

- [ ] **Step 2: Run the API/decimal tests and confirm red**

Run:

```bash
pnpm vitest run src/features/grids/grid-api.test.ts src/features/grids/decimal-display.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the exact server response types and list request**

Create `types.ts`:

```ts
export interface GridTradeSummary {
  id: string; productName: string | null; productCode: string;
  maxPrice: string; perShare: string; isShort: boolean;
  algorithmVersion: "android-v2.1.0"; createdAt: string; updatedAt: string;
}
export interface GridTradePage { items: GridTradeSummary[]; nextCursor: string | null; }
```

Create `grid-api.ts`:

```ts
import { requestJson } from "@/lib/api-client";
import type { GridTradePage } from "./types";

export function listGridTrades({ q, cursor, signal }: { q?: string; cursor?: string; signal?: AbortSignal } = {}) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", "20");
  return requestJson<GridTradePage>(`/grid-trades?${params}` as `/${string}`, { signal });
}
```

Create `decimal-display.ts`:

```ts
export function formatDecimal(value: string): string {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction] = unsigned.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}
```

- [ ] **Step 4: Re-run API/decimal tests and confirm green**

Run:

```bash
pnpm vitest run src/features/grids/grid-api.test.ts src/features/grids/decimal-display.test.ts
```

- [ ] **Step 5: Write failing hook tests for stale search and retained pagination data**

Create `use-grid-trades.test.tsx` with jsdom. Use deferred promises as the external API double, and assert the hook's real state:

```tsx
// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ClientApiError } from "@/lib/api-client";
import { useGridTrades } from "./use-grid-trades";
import type { GridTradePage } from "./types";

const item = (id: string) => ({ id, productName: id, productCode: id, maxPrice: "1", perShare: "2000", isShort: false, algorithmVersion: "android-v2.1.0" as const, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" });

it("debounces search and ignores the response for an older query", async () => {
  vi.useFakeTimers();
  const resolvers = new Map<string, (page: GridTradePage) => void>();
  const request = vi.fn(({ q = "" }: { q?: string }) => new Promise<GridTradePage>((resolve) => resolvers.set(q, resolve)));
  const { result } = renderHook(() => useGridTrades({ request }));
  act(() => result.current.setQuery("gold"));
  act(() => vi.advanceTimersByTime(250));
  act(() => result.current.setQuery("oil"));
  act(() => vi.advanceTimersByTime(250));
  await act(async () => { resolvers.get("oil")!({ items: [item("oil")], nextCursor: null }); });
  await act(async () => { resolvers.get("gold")!({ items: [item("gold")], nextCursor: null }); });
  expect(result.current.items.map((entry) => entry.id)).toEqual(["oil"]);
  vi.useRealTimers();
});

it("retains loaded items when the next cursor fails and retries that cursor", async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ items: [item("first")], nextCursor: "c2" })
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ items: [item("second")], nextCursor: null });
  const { result } = renderHook(() => useGridTrades({ request }));
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  await act(() => result.current.loadMore());
  expect(result.current.items.map((entry) => entry.id)).toEqual(["first"]);
  expect(result.current.pageError).toBe("加载更多失败");
  await act(() => result.current.retryPage());
  expect(result.current.items.map((entry) => entry.id)).toEqual(["first", "second"]);
  expect(request.mock.calls[2][0].cursor).toBe("c2");
});

it("includes the request ID in an initial service error", async () => {
  const request = vi.fn().mockRejectedValue(new ClientApiError(503, "UNAVAILABLE", "不可用", "01GRID"));
  const { result } = renderHook(() => useGridTrades({ request }));
  await waitFor(() => expect(result.current.initialError).toBe("加载产品失败，请求 ID：01GRID"));
});
```

- [ ] **Step 6: Run the hook test and confirm red**

Run:

```bash
pnpm vitest run src/features/grids/use-grid-trades.test.tsx
```

Expected: FAIL because the hook does not exist.

- [ ] **Step 7: Implement the controller state machine**

Create `use-grid-trades.ts` as a client hook with this public result and request boundary:

```ts
export interface GridTradeListController {
  query: string; setQuery(value: string): void; clearQuery(): void;
  items: GridTradeSummary[]; nextCursor: string | null;
  initialLoading: boolean; pageLoading: boolean;
  initialError: string; pageError: string;
  refresh(): Promise<void>; loadMore(): Promise<void>; retryPage(): Promise<void>;
}
export type ListGridTrades = (input?: { q?: string; cursor?: string; signal?: AbortSignal }) => Promise<GridTradePage>;
```

Implement the complete fresh-query and cursor state machine:

```ts
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ClientApiError } from "@/lib/api-client";
import { listGridTrades } from "./grid-api";
import type { GridTradePage, GridTradeSummary } from "./types";

function publicMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.name === "AbortError") return "";
  if (error instanceof TypeError) return "网络连接失败，请重试";
  return error instanceof ClientApiError && error.requestId
    ? `${fallback}，请求 ID：${error.requestId}`
    : fallback;
}

export function useGridTrades({ request = listGridTrades }: { request?: ListGridTrades } = {}): GridTradeListController {
const [query, setQuery] = useState("");
const [effectiveQuery, setEffectiveQuery] = useState("");
const [items, setItems] = useState<GridTradeSummary[]>([]);
const [nextCursor, setNextCursor] = useState<string | null>(null);
const [initialLoading, setInitialLoading] = useState(true);
const [pageLoading, setPageLoading] = useState(false);
const [initialError, setInitialError] = useState("");
const [pageError, setPageError] = useState("");
const requestVersion = useRef(0);
const pageInFlight = useRef<string | null>(null);
const failedCursor = useRef<string | null>(null);
const abortController = useRef<AbortController | null>(null);

useEffect(() => {
  const timer = window.setTimeout(() => setEffectiveQuery(query.trim()), 250);
  return () => window.clearTimeout(timer);
}, [query]);

const loadFresh = useCallback(async (q: string, preserveCurrent = false) => {
  const version = ++requestVersion.current;
  abortController.current?.abort();
  const controller = new AbortController();
  abortController.current = controller;
  setInitialLoading(true); setPageLoading(false); setInitialError(""); setPageError(""); setNextCursor(null);
  if (!preserveCurrent) setItems([]);
  failedCursor.current = null; pageInFlight.current = null;
  try {
    const page = await request({ q: q || undefined, signal: controller.signal });
    if (version !== requestVersion.current) return;
    setItems(page.items); setNextCursor(page.nextCursor);
  } catch (error) {
    if (version === requestVersion.current) setInitialError(publicMessage(error, "加载产品失败"));
  } finally {
    if (version === requestVersion.current) setInitialLoading(false);
  }
}, [request]);

useEffect(() => { void loadFresh(effectiveQuery, false); return () => abortController.current?.abort(); }, [effectiveQuery, loadFresh]);

const loadCursor = useCallback(async (cursor: string) => {
  if (pageInFlight.current === cursor) return;
  const version = requestVersion.current;
  pageInFlight.current = cursor; setPageLoading(true); setPageError("");
  try {
    const page = await request({ q: effectiveQuery || undefined, cursor });
    if (version !== requestVersion.current) return;
    setItems((current) => [...current, ...page.items]); setNextCursor(page.nextCursor); failedCursor.current = null;
  } catch {
    if (version === requestVersion.current) { failedCursor.current = cursor; setPageError("加载更多失败"); }
  } finally {
    if (version === requestVersion.current) { pageInFlight.current = null; setPageLoading(false); }
  }
}, [effectiveQuery, request]);

return {
  query, setQuery, clearQuery: () => { setQuery(""); setEffectiveQuery(""); }, items, nextCursor,
  initialLoading, pageLoading, initialError, pageError,
  refresh: () => loadFresh(effectiveQuery, true),
  loadMore: () => nextCursor ? loadCursor(nextCursor) : Promise.resolve(),
  retryPage: () => failedCursor.current ? loadCursor(failedCursor.current) : Promise.resolve(),
};
}
```

- [ ] **Step 8: Verify Task 5 and commit**

Run:

```bash
pnpm vitest run src/features/grids/grid-api.test.ts src/features/grids/decimal-display.test.ts src/features/grids/use-grid-trades.test.tsx
pnpm typecheck
```

Commit:

```bash
git add src/features/grids/types.ts src/features/grids/grid-api.ts src/features/grids/grid-api.test.ts src/features/grids/decimal-display.ts src/features/grids/decimal-display.test.ts src/features/grids/use-grid-trades.ts src/features/grids/use-grid-trades.test.tsx
git commit -m "feat: add grid list data controller"
```

---

### Task 6: Responsive Product Workspace UI

**Files:**
- Create: `src/features/grids/grid-workspace.tsx`
- Create: `src/features/grids/grid-workspace.test.tsx`
- Create: `src/features/grids/grid-workspace.module.css`
- Create: `src/app/(protected)/grids/page.tsx`

**Interfaces:**
- Consumes: `useGridTrades`, `formatDecimal`, and `GridTradeSummary` from Task 5.
- Produces: `GridWorkspace()` using the real hook and `GridWorkspaceView({ controller })` as the pure tested renderer.

- [ ] **Step 1: Write failing visible-behavior tests**

Create `grid-workspace.test.tsx` with jsdom and a real controller-shaped fixture:

```tsx
// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { GridWorkspaceView } from "./grid-workspace";

const product = { id: "g1", productName: "黄金ETF网格", productCode: "518880", maxPrice: "6.9200", perShare: "1500", isShort: false, algorithmVersion: "android-v2.1.0" as const, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
const controller = (patch = {}) => ({ query: "", setQuery: vi.fn(), clearQuery: vi.fn(), items: [product], nextCursor: null, initialLoading: false, pageLoading: false, initialError: "", pageError: "", refresh: vi.fn(), loadMore: vi.fn(), retryPage: vi.fn(), ...patch });

it("renders the four App fields in desktop and mobile representations", () => {
  render(<GridWorkspaceView controller={controller()} />);
  const table = screen.getByRole("table", { name: "网格产品" });
  expect(within(table).getByText("黄金ETF网格")).toBeInTheDocument();
  expect(within(table).getByText("518880")).toBeInTheDocument();
  expect(within(table).getByText("6.9200")).toBeInTheDocument();
  expect(within(table).getByText("1,500")).toBeInTheDocument();
  expect(within(table).getByText("当前账号的网格产品")).toBeInTheDocument();
  expect(screen.getByText("已载入 1 项")).toBeInTheDocument();
  const cards = screen.getByRole("list", { name: "网格产品卡片" });
  for (const value of ["黄金ETF网格", "518880", "6.9200", "1,500"]) {
    expect(within(cards).getByText(value)).toBeInTheDocument();
  }
});

it("distinguishes an empty account from an empty search", () => {
  const { rerender } = render(<GridWorkspaceView controller={controller({ items: [] })} />);
  expect(screen.getByText("还没有网格产品")).toBeInTheDocument();
  rerender(<GridWorkspaceView controller={controller({ items: [], query: "gold" })} />);
  expect(screen.getByText("没有匹配的产品")).toBeInTheDocument();
});

it("clears search and exposes keyboard pagination retry", async () => {
  const value = controller({ query: "gold", nextCursor: "c2", pageError: "加载更多失败" });
  render(<GridWorkspaceView controller={value} />);
  await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
  await userEvent.click(screen.getByRole("button", { name: "重试加载更多" }));
  expect(value.clearQuery).toHaveBeenCalledTimes(1);
  expect(value.retryPage).toHaveBeenCalledTimes(1);
});

it("keeps existing rows visible when refresh fails and exposes a retry", async () => {
  const value = controller({ initialError: "加载产品失败" });
  render(<GridWorkspaceView controller={value} />);
  expect(screen.getByText("黄金ETF网格")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "重试刷新" }));
  expect(value.refresh).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the workspace tests and confirm red**

Run:

```bash
pnpm vitest run src/features/grids/grid-workspace.test.tsx
```

Expected: FAIL because the workspace component does not exist.

- [ ] **Step 3: Implement the semantic workspace**

Create a client `GridWorkspace` wrapper and pure `GridWorkspaceView` renderer. The wrapper always owns the real hook, so test injection never triggers a hidden network request:

```tsx
"use client";
import type { UIEvent } from "react";
import { formatDecimal } from "./decimal-display";
import { useGridTrades, type GridTradeListController } from "./use-grid-trades";
import styles from "./grid-workspace.module.css";

export function GridWorkspace() {
  return <GridWorkspaceView controller={useGridTrades()} />;
}

export function GridWorkspaceView({ controller }: { controller: GridTradeListController }) {
  function nearBottom(event: UIEvent<HTMLElement>) {
    const target = event.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight <= 240) void controller.loadMore();
  }
  const emptyText = controller.query ? "没有匹配的产品" : "还没有网格产品";
  return <section className={styles.workspace} aria-labelledby="grid-title">
    <header className={styles.heading}>
      <div><span>Grid strategies · 已载入 {controller.items.length} 项</span><h1 id="grid-title">网格产品</h1></div>
      <button onClick={() => void controller.refresh()}>刷新</button>
    </header>
    <div className={styles.searchBar}>
      <label htmlFor="grid-search">搜索产品名称或代码</label>
      <input id="grid-search" type="search" value={controller.query} onChange={(event) => controller.setQuery(event.target.value)} />
      {controller.query && <button onClick={controller.clearQuery}>清除搜索</button>}
    </div>
    {controller.initialError && !controller.items.length && <div role="alert">{controller.initialError}<button onClick={() => void controller.refresh()}>重试</button></div>}
    {controller.initialError && !!controller.items.length && <div role="alert">{controller.initialError}<button onClick={() => void controller.refresh()}>重试刷新</button></div>}
    {controller.initialLoading && !controller.items.length && <div role="status" className={styles.loading}>正在加载产品…</div>}
    {!controller.initialLoading && !controller.initialError && !controller.items.length && <div className={styles.empty}>{emptyText}</div>}
    {!!controller.items.length && <div className={styles.listViewport} onScroll={nearBottom}>
      <table className={styles.desktopTable} aria-label="网格产品">
        <caption className={styles.srOnly}>当前账号的网格产品</caption>
        <thead><tr><th scope="col">产品名称</th><th scope="col">产品代码</th><th scope="col">最高价</th><th scope="col">每份金额</th></tr></thead>
        <tbody>{controller.items.map((item) => <tr key={item.id}><td>{item.productName || item.productCode}</td><td className={styles.numeric}>{item.productCode}</td><td className={styles.numeric}>{formatDecimal(item.maxPrice)}</td><td className={styles.numeric}>{formatDecimal(item.perShare)}</td></tr>)}</tbody>
      </table>
      <ul className={styles.mobileCards} aria-label="网格产品卡片">{controller.items.map((item) => <li key={item.id}><h2>{item.productName || item.productCode}</h2><dl><div><dt>产品代码</dt><dd>{item.productCode}</dd></div><div><dt>最高价</dt><dd>{formatDecimal(item.maxPrice)}</dd></div><div><dt>每份金额</dt><dd>{formatDecimal(item.perShare)}</dd></div></dl></li>)}</ul>
    </div>}
    <div className={styles.pagination} aria-live="polite">
      {controller.pageError ? <><span>{controller.pageError}</span><button onClick={() => void controller.retryPage()}>重试加载更多</button></> : controller.nextCursor ? <button disabled={controller.pageLoading} onClick={() => void controller.loadMore()}>{controller.pageLoading ? "正在加载…" : "加载更多"}</button> : null}
    </div>
  </section>;
}
```

When items exist, the component above renders both:

- `<table aria-label="网格产品">` with headers `产品名称`, `产品代码`, `最高价`, `每份金额`.
- `<ul aria-label="网格产品卡片">` with the same four visible values and explicit `<dt>/<dd>` labels.

The desktop table and mobile card list are mutually hidden by CSS media queries; `display: none` ensures the inactive representation is excluded from the accessibility tree. The scrollable list container uses the `nearBottom` implementation above.

```ts
function nearBottom(event: React.UIEvent<HTMLElement>) {
  const target = event.currentTarget;
  if (target.scrollHeight - target.scrollTop - target.clientHeight <= 240) {
    void controller.loadMore();
  }
}
```

The renderer always exposes a focusable `加载更多` button when `nextCursor` exists. It renders `重试加载更多` on `pageError`, a page-level `重试` on initial failure, and keeps pagination messaging in the polite live region.

- [ ] **Step 4: Implement the approved responsive CSS**

Create `grid-workspace.module.css`:

```css
.workspace { min-width: 0; }
.heading { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.heading span { color: var(--text-muted); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
.heading h1 { margin: 5px 0 0; font-size: 26px; letter-spacing: -.035em; }
.heading button, .searchBar button, .pagination button { min-height: 44px; border: 1px solid var(--line); border-radius: 5px; color: var(--text); background: var(--surface); }
.searchBar { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-bottom: 14px; padding-bottom: 10px; background: var(--canvas); }
.searchBar label { grid-column: 1 / -1; color: var(--text-muted); font-size: 12px; }
.searchBar input { min-height: 44px; padding: 0 13px; border: 1px solid var(--line); border-radius: 5px; color: var(--text); background: var(--surface); }
.listViewport { max-height: calc(100dvh - 220px); overflow: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
.desktopTable { width: 100%; border-collapse: collapse; }
.desktopTable th, .desktopTable td { min-height: 44px; padding: 13px 14px; border-bottom: 1px solid var(--line); text-align: left; }
.desktopTable th { position: sticky; top: 0; color: var(--text-muted); background: var(--surface-raised); font-size: 11px; }
.desktopTable th:not(:first-child), .desktopTable td:not(:first-child) { text-align: right; }
.numeric { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-variant-numeric: tabular-nums; }
.mobileCards { display: none; }
.pagination { min-height: 52px; display: flex; align-items: center; justify-content: center; gap: 10px; color: #ff7b84; }
.pagination button { padding: 0 14px; }
.empty, .loading { padding: 72px 20px; border: 1px solid var(--line); color: var(--text-muted); background: var(--surface); text-align: center; }
.srOnly { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 767px) { .heading { align-items: center; } .desktopTable { display: none; } .listViewport { max-height: calc(100dvh - 270px); overflow: auto; border: 0; background: transparent; } .mobileCards { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; } .mobileCards li { padding: 16px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); } .mobileCards h2 { margin: 0 0 14px; font-size: 16px; } .mobileCards dl { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 0; } .mobileCards dl div { min-width: 0; } .mobileCards dt { color: var(--text-muted); font-size: 11px; } .mobileCards dd { margin: 5px 0 0; overflow: hidden; font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; text-overflow: ellipsis; font-variant-numeric: tabular-nums; } }
```

Create `src/app/(protected)/grids/page.tsx`:

```tsx
import { GridWorkspace } from "@/features/grids/grid-workspace";
export default function GridsPage() { return <GridWorkspace />; }
```

- [ ] **Step 5: Verify Task 6 and commit**

Run:

```bash
pnpm vitest run src/features/grids/grid-workspace.test.tsx src/features/grids/use-grid-trades.test.tsx
pnpm typecheck
pnpm lint
```

Commit:

```bash
git add src/features/grids/grid-workspace.tsx src/features/grids/grid-workspace.test.tsx src/features/grids/grid-workspace.module.css 'src/app/(protected)/grids/page.tsx'
git commit -m "feat: add responsive grid product workspace"
```

---

### Task 7: Full Regression, Visual QA, and One-Click Deployment Evidence

**Files:**
- Modify: `docs/fit-replication/server-implementation-status.md`
- Modify: `docs/fit-replication/low-memory-vps-runbook.md`
- Modify only if verification exposes a real defect: files from Tasks 1–6 with a failing regression test added first.

**Interfaces:**
- Consumes: all completed frontend routes and existing production assets.
- Produces: verified `/fitgrid` standalone build and documented post-upgrade frontend smoke procedure.

- [ ] **Step 1: Run the complete automated gate from a clean working tree**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
NEXT_BASE_PATH=/fitgrid pnpm build
sh -n ops/*.sh ops/lib/*.sh docker/postgres/init-app-role.sh
git diff --check
```

Expected:

- All Vitest files pass, with only explicitly environment-gated PostgreSQL tests skipped.
- TypeScript and ESLint exit 0.
- Next.js reports successful production compilation and includes `/`, `/login`, and `/grids` routes.
- All shell syntax and whitespace checks exit 0.

- [ ] **Step 2: Start the production build locally and perform desktop/mobile visual QA**

Use a local PostgreSQL test environment or the existing development environment, create a test administrator through the existing CLI, then run:

```bash
NEXT_BASE_PATH=/fitgrid pnpm build
APP_BASE_PATH=/fitgrid PORT=3300 pnpm start
```

Verify at 1440×900 and 390×844:

- Anonymous `/fitgrid/` reaches `/fitgrid/login` without a redirect loop.
- Login keyboard order is username, password, submit.
- The price ladder is decorative, performs one entrance, and stops under reduced motion.
- Successful login reaches `/fitgrid/grids` and displays only the authenticated user's products.
- Search, clear, refresh, load more, failure retry, and logout work.
- Desktop table and mobile cards show the same four fields.
- Browser console has no hydration, accessibility, or failed-resource errors.

If a failure appears, add the smallest failing automated regression test to the responsible task's test file before changing production code.

- [ ] **Step 3: Record the verified frontend status**

Add a “前端基础” section to `server-implementation-status.md` recording these exact evidence classes:

```markdown
- 登录、会话恢复和受保护布局使用现有 Better Auth 数据库会话；浏览器不读取 token。
- `/grids` 已连接 owner-scoped `GET /api/v1/grid-trades`，覆盖搜索、清除、稳定游标分页和保留数据重试。
- TradingView 风格桌面表格和手机卡片通过组件测试与 `/fitgrid` 生产构建。
- 新增、详情、导入导出和管理页面仍属于后续前端阶段。
```

Do not upgrade any existing database/RLS/backup environment gate from pending unless that exact environment exercise was run.

- [ ] **Step 4: Add the frontend production smoke procedure to the runbook**

Append these post-upgrade checks to `low-memory-vps-runbook.md`:

```bash
curl -fsSIL --max-redirs 5 https://YOUR_DOMAIN/fitgrid/
curl -fsS https://YOUR_DOMAIN/fitgrid/api/v1/health
```

Document the browser checks: open `/fitgrid/`, log in, search a known product, clear the search, confirm the same account data, and log out. State that the upgrade remains:

```bash
/opt/fitgridweb/ops/install-production.sh --upgrade
```

At the Git-ref prompt enter `main` (or the reviewed immutable commit SHA); accept existing domain, port, swap, and no-admin defaults. Explicitly retain the sing-box subscription verification on port `30127`.

- [ ] **Step 5: Commit the final documentation and any regression fixes**

Run:

```bash
git add docs/fit-replication/server-implementation-status.md docs/fit-replication/low-memory-vps-runbook.md
git commit -m "docs: add frontend deployment verification"
```

- [ ] **Step 6: Request independent code review before publishing**

Provide the reviewer with the design spec, this plan, the base SHA `750e1430650d54545192a119eedf7b622385ac40`, and the final branch HEAD. Require review of session leakage, open redirects, stale request handling, accessibility, responsive behavior, base-path correctness, and the unchanged single-image deployment.

- [ ] **Step 7: Publish only after review and fresh verification**

After fixing all Critical and Important findings with failing tests first, rerun the complete Step 1 gate. Push `codex/frontend-foundation`, run the GitHub “Server image” workflow on the branch, merge through a pull request, wait for the `main` workflow, and anonymously verify:

```bash
sh -c '. ./ops/lib/install-common.sh; assert_public_image ghcr.io/zhshy7713950/fitgridweb:sha-<MERGE_COMMIT_SHA>'
```

Only then provide the VPS upgrade command. The production installer, Compose files, nginx FitGrid snippet, and sing-box subscription vhost require no frontend-specific mutation.
