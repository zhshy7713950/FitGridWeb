# Account and Admin Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver invitation registration, password change, administrator invitation creation, and user status management without exposing product data.

**Architecture:** Keep public invitation UI outside the protected layout and put security/admin screens inside the current session-protected shell. Add typed feature-local API modules; role-based navigation improves discoverability while server endpoints remain the authority for authentication and authorization.

**Tech Stack:** Next.js 16, React 19, Better Auth-backed same-origin APIs, TypeScript, CSS Modules, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-02-fitgridweb-remaining-frontend-and-android-import-design.md`

## Global Constraints

- Username length is 3–64 characters; password length is 12–128 characters.
- Passwords are never stored in localStorage, sessionStorage, cookies created by UI code, URLs, or logs.
- Only administrators see admin navigation; the server still returns 403 for unauthorized requests.
- Administrators cannot view, search, or export another user's products.
- Mobile uses top navigation/menu and no fixed bottom navigation.
- Invitation URLs use `/invite/[token]` and work beneath `/fitgrid`.
- Use `frontend-design` before changing production visual styles.

---

### Task 1: Expand safe return paths and shell navigation contract

**Files:**
- Modify: `src/lib/app-paths.ts`
- Modify: `src/lib/app-paths.test.ts`
- Modify: `src/components/app-shell/app-shell.tsx`
- Modify: `src/components/app-shell/app-shell.test.tsx`
- Modify: `src/components/app-shell/app-shell.module.css`

**Interfaces:**
- Consumes: existing `SessionUser` and `withBasePath` behavior.
- Produces: safe authenticated return routes for `/grids`, `/settings/security`, and `/admin`, plus role-aware top/rail navigation.

- [ ] **Step 1: Write failing routing and navigation tests**

```ts
expect(safeReturnPath("/settings/security")).toBe("/settings/security");
expect(safeReturnPath("/admin?cursor=safe")).toBe("/admin?cursor=safe");
expect(safeReturnPath("/invite/token")).toBe("/grids");
```

```tsx
it("shows admin navigation only to administrators", () => {
  const { rerender } = render(<AppShell user={member}>{children}</AppShell>);
  expect(screen.queryByRole("link", { name: "账号管理" })).not.toBeInTheDocument();
  rerender(<AppShell user={admin}>{children}</AppShell>);
  expect(screen.getByRole("link", { name: "账号管理" })).toHaveAttribute("href", "/admin");
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run src/lib/app-paths.test.ts src/components/app-shell/app-shell.test.tsx`

Expected: FAIL for settings/admin return paths and missing links.

- [ ] **Step 3: Implement route allowlisting and responsive navigation**

Allow exact `/settings/security`, exact `/admin`, and `/admin?...`; keep the existing traversal, encoded slash, external-origin, and protocol-relative defenses. Add “网格产品”, “安全设置”, and admin-only “账号管理” links. Use CSS to keep the desktop rail fixed and collapse links into the existing top menu region below 768 px, never the viewport bottom.

- [ ] **Step 4: Run focused tests and commit**

Run: `pnpm exec vitest run src/lib/app-paths.test.ts src/components/app-shell/app-shell.test.tsx`

Expected: PASS.

```bash
git add src/lib/app-paths.ts src/lib/app-paths.test.ts src/components/app-shell/app-shell.tsx src/components/app-shell/app-shell.test.tsx src/components/app-shell/app-shell.module.css
git commit -m "feat: add account and admin navigation"
```

### Task 2: Invitation API and public registration page

**Files:**
- Create: `src/features/invitations/types.ts`
- Create: `src/features/invitations/invitation-api.ts`
- Create: `src/features/invitations/invitation-api.test.ts`
- Create: `src/features/invitations/invitation-page.tsx`
- Create: `src/features/invitations/invitation-page.test.tsx`
- Create: `src/features/invitations/invitation.module.css`
- Create: `src/features/invitations/demo-invitation-data.ts`
- Create: `src/app/invite/[token]/page.tsx`
- Modify: `src/app/api/v1/admin/invitations/route.ts`
- Modify: `src/server/http/api-contract.test.ts`
- Modify: `src/server/config/base-path.test.ts`

**Interfaces:**
- Consumes: public invitation GET/POST endpoints and existing login visual language.
- Produces: `getInvitationStatus(token)` and `acceptInvitation(token, username, password)`.

- [ ] **Step 1: Write failing API and page-state tests**

```tsx
it.each(["used", "expired"] as const)("does not show registration fields for %s invitations", async (status) => {
  render(<InvitationPageView state={{ kind: status, expiresAt: null }} />);
  expect(screen.queryByLabelText("用户名")).not.toBeInTheDocument();
});

it("requires matching passwords before accepting", async () => {
  render(<InvitationPageView state={{ kind: "valid", expiresAt: "2026-09-03T00:00:00.000Z" }} accept={accept} />);
  await user.type(screen.getByLabelText("密码"), "strong-password-1");
  await user.type(screen.getByLabelText("确认密码"), "different-password");
  await user.click(screen.getByRole("button", { name: "创建账号" }));
  expect(accept).not.toHaveBeenCalled();
});
```

Add a route contract assertion that a created invite URL ends with `/invite/<token>` rather than `/accept-invitation/<token>`.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run src/features/invitations src/server/http/api-contract.test.ts`

Expected: FAIL because the client feature is missing and the server still emits the old path.

- [ ] **Step 3: Implement typed API and public page**

```ts
export type InvitationStatus = { status: "valid" | "used" | "expired"; expiresAt: string | null };
export function getInvitationStatus(token: string) { return requestJson<InvitationStatus>(`/invitations/${encodeURIComponent(token)}`); }
export function acceptInvitation(token: string, username: string, password: string) {
  return requestJson<SessionUser>(`/invitations/${encodeURIComponent(token)}/accept`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
  });
}
```

The page renders loading, valid, used, expired, invalid/404, submitting, and success states. After success, `router.replace("/login")`. Keep passwords only in React state and clear them after success.

In UI demo mode, `valid-demo-invitation-token-000001` returns a deterministic valid status and any other demo token returns the invalid state; production always calls the real endpoint.

- [ ] **Step 4: Align generated invitation URLs**

Build the public URL with the configured base path so production emits `/fitgrid/invite/...` while local development emits `/invite/...`:

```ts
const basePath = normalizeBasePath(process.env.APP_BASE_PATH);
const inviteUrl = new URL(`${basePath}/invite/${invitation.token}`, request.url).toString();
```

Add the thin route adapter with awaited params. Test both an unset `APP_BASE_PATH` and `/fitgrid`; both URLs must remain on the request origin.

- [ ] **Step 5: Run focused tests and commit**

Run: `pnpm exec vitest run src/features/invitations src/server/http/api-contract.test.ts src/server/config/base-path.test.ts src/app/base-path-routing.test.tsx`

Expected: PASS.

```bash
git add src/features/invitations src/app/invite/'[token]'/page.tsx src/app/api/v1/admin/invitations/route.ts src/server/http/api-contract.test.ts src/server/config/base-path.test.ts
git commit -m "feat: add invitation registration page"
```

### Task 3: Password change page

**Files:**
- Create: `src/features/account/account-api.ts`
- Create: `src/features/account/account-api.test.ts`
- Create: `src/features/account/security-page.tsx`
- Create: `src/features/account/security-page.test.tsx`
- Create: `src/features/account/security.module.css`
- Create: `src/app/(protected)/settings/security/page.tsx`

**Interfaces:**
- Consumes: `POST /auth/change-password`.
- Produces: `changePassword(currentPassword, newPassword): Promise<void>` and the protected security form.

- [ ] **Step 1: Write failing tests**

```tsx
it("does not submit a short or mismatched new password", async () => {
  render(<SecurityPage changePassword={changePassword} />);
  await user.type(screen.getByLabelText("当前密码"), "current-password");
  await user.type(screen.getByLabelText("新密码"), "short");
  await user.type(screen.getByLabelText("确认新密码"), "different");
  await user.click(screen.getByRole("button", { name: "修改密码" }));
  expect(changePassword).not.toHaveBeenCalled();
});
```

API test asserts a POST JSON body containing only `currentPassword` and `newPassword`.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run src/features/account`

Expected: FAIL because the account feature is missing.

- [ ] **Step 3: Implement API and secure form**

Use controlled password inputs with `autoComplete="current-password"` and `autoComplete="new-password"`; enforce 12–128 characters and exact confirmation. Map `CURRENT_PASSWORD_INVALID` beside the current-password field. Disable repeat submission, clear all three fields on success, and show “密码已更新，其他设备的会话已撤销”。

- [ ] **Step 4: Add route, test, and commit**

Run: `pnpm exec vitest run src/features/account src/app/base-path-routing.test.tsx`

Expected: PASS.

```bash
git add src/features/account src/app/'(protected)'/settings/security/page.tsx
git commit -m "feat: add password security page"
```

### Task 4: Administrator API and dashboard

**Files:**
- Create: `src/features/admin/types.ts`
- Create: `src/features/admin/admin-api.ts`
- Create: `src/features/admin/admin-api.test.ts`
- Create: `src/features/admin/admin-workspace.tsx`
- Create: `src/features/admin/admin-workspace.test.tsx`
- Create: `src/features/admin/admin.module.css`
- Create: `src/features/admin/demo-admin-data.ts`
- Create: `src/app/(protected)/admin/page.tsx`

**Interfaces:**
- Consumes: `GET /admin/users`, `PATCH /admin/users/{userId}/status`, and `POST /admin/invitations`.
- Produces: `listUsers`, `updateUserStatus`, `createInvitation`, and the admin dashboard.

- [ ] **Step 1: Write failing API and UI tests**

```tsx
it("shows no product counts or product actions", () => {
  render(<AdminWorkspaceView controller={controller} />);
  expect(screen.queryByText(/产品数量/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /查看产品/ })).not.toBeInTheDocument();
});

it("confirms before disabling an account", async () => {
  render(<AdminWorkspaceView controller={controller} />);
  await user.click(screen.getByRole("button", { name: `禁用 ${member.username}` }));
  expect(screen.getByRole("dialog", { name: "确认禁用账号" })).toBeInTheDocument();
  expect(controller.updateStatus).not.toHaveBeenCalled();
});
```

API tests assert cursor/limit query handling, `{ status }` PATCH body, and `{ expiresInHours }` invitation body.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run src/features/admin`

Expected: FAIL because the admin feature is missing.

- [ ] **Step 3: Define and implement exact API DTOs**

```ts
export type ManagedUser = { id: string; username: string; role: "member" | "admin"; status: "active" | "disabled"; createdAt: string };
export type ManagedUserPage = { items: ManagedUser[]; nextCursor: string | null };
export type CreatedInvitation = { id: string; inviteUrl: string; expiresAt: string };
```

Implement list, next-page, status update, and invitation creation through `requestJson`.

- [ ] **Step 4: Implement dashboard behavior**

Show username, role, status, and created time only. Use 24 hours as the initial invitation TTL and constrain input to 1–168. After creation show the URL once with a Clipboard API button and manual-select fallback. Confirm enable/disable, disable action buttons while pending, and surface `LAST_ACTIVE_ADMIN` without mutating the displayed row.

```tsx
<button type="button" disabled={pendingUserId === user.id} onClick={() => setConfirmation({ user, status: user.status === "active" ? "disabled" : "active" })}>
  {user.status === "active" ? `禁用 ${user.username}` : `启用 ${user.username}`}
</button>
```

Add a demo-only in-memory list in `demo-admin-data.ts`; `admin-api.ts` selects it only when `isUiDemoMode()` is true, while production always calls `/admin/*`.

- [ ] **Step 5: Add admin route defense**

The protected layout handles authentication. The admin page performs the role check explicitly:

```tsx
export default async function AdminPage() {
  const user = isUiDemoMode() ? uiDemoUser() : await getOptionalSession(await headers());
  if (!user) redirect(protectedLoginRoute("/admin"));
  if (user.role !== "admin") redirect("/grids");
  return <AdminWorkspace />;
}
```

Keep API 403 handling as the authoritative fallback. Extend `src/app/base-path-routing.test.tsx` to mock member/admin sessions and assert the redirect/render behavior.

- [ ] **Step 6: Run focused tests and commit**

Run: `pnpm exec vitest run src/features/admin src/components/app-shell/app-shell.test.tsx src/app/base-path-routing.test.tsx`

Expected: PASS.

```bash
git add src/features/admin src/app/'(protected)'/admin/page.tsx
git commit -m "feat: add administrator workspace"
```

### Task 5: End-to-end account release gate

**Files:**
- Modify: `src/e2e/ui-demo.smoke.test.ts`
- Modify: `src/server/config/ui-demo-config.test.ts`

**Interfaces:**
- Consumes: all routes from Tasks 1–4.
- Produces: deterministic UI-demo coverage for member/admin navigation without weakening production authorization.

- [ ] **Step 1: Add failing UI-demo smoke scenarios**

Add these browser assertions using the existing local demo server helper:

```ts
await page.goto(`${baseUrl}/invite/invalid-demo-invitation-token-0001`);
await expect(page.getByText("邀请无效或已失效")).toBeVisible();
await page.goto(`${baseUrl}/grids`);
await expect(page.getByRole("link", { name: "安全设置" })).toBeVisible();
await expect(page.getByRole("link", { name: "账号管理" })).toBeVisible();
await page.setViewportSize({ width: 390, height: 844 });
await expect(page.locator("nav")).not.toHaveCSS("position", "fixed");
```

- [ ] **Step 2: Run the smoke test and confirm failure**

Run: `pnpm exec vitest run src/e2e/ui-demo.smoke.test.ts src/server/config/ui-demo-config.test.ts`

Expected: FAIL until deterministic invitation/admin demo adapters and the new routes exist.

- [ ] **Step 3: Prove demo behavior remains development-only**

Extend the production configuration test with the existing hard failure and add a direct adapter assertion:

```ts
vi.stubEnv("NODE_ENV", "production");
vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
await expect(import("../../../next.config")).rejects.toThrow("UI demo mode is development-only");
```

The browser smoke uses the existing admin `uiDemoUser()`; member-only navigation hiding remains covered by the AppShell component test in Task 1.

- [ ] **Step 4: Run the complete project gate**

Run: `pnpm test`

Expected: all tests pass, with only environment-gated PostgreSQL integration tests skipped when no `TEST_DATABASE_URL` is configured.

Run: `pnpm typecheck`

Expected: exit 0.

Run: `pnpm lint`

Expected: exit 0.

Run: `NEXT_PUBLIC_APP_BASE_PATH=/fitgrid pnpm build`

Expected: exit 0 and routes include `/invite/[token]`, `/settings/security`, and `/admin`.

- [ ] **Step 5: Commit end-to-end coverage**

```bash
git add src/e2e/ui-demo.smoke.test.ts src/server/config/ui-demo-config.test.ts
git commit -m "test: cover account and admin frontend"
```
