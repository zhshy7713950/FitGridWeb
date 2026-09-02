# Task 4 Report: Administrator API and Dashboard

## Delivered

- Added OpenAPI-aligned administrator DTOs and typed clients for:
  - `GET /admin/users` with `cursor`, `limit`, and `AbortSignal`.
  - `PATCH /admin/users/{userId}/status` with the exact `{ status }` body.
  - `POST /admin/invitations` with the exact `{ expiresInHours }` body.
- Added a no-polling account-list controller with explicit initial, retry, pagination, and page-error states. Requests are aborted on teardown, stale generations are ignored, cursor requests are coalesced, repeated IDs are not appended, and a late page cannot overwrite a newer server-authoritative status response.
- Added a development-only, deterministic in-memory administrator adapter. Production always uses the real API. The optimized production runtime JavaScript contains no demo repository import, demo usernames, demo invitation token, or demo error identifiers.
- Added the dense seven-color administrator ledger. It renders username, role, status, created time, and status action only; it never requests or renders product data.
- Added invitation TTL validation (`1–168`, default `24`), a synchronous creation lock, React-only generated-link state, replacement on new creation, Retry-After gating, and Clipboard API handling. Clipboard failure selects the readonly URL input and gives manual-copy guidance without reporting false success.
- Added the accessible enable/disable confirmation modal with document isolation, focus trap/restoration, scroll lock/restoration, Escape/backdrop handling, synchronous status lock, target-row pending disablement, and abort-on-unmount behavior.
- Prevented the signed-in administrator from disabling their own current account. `LAST_ACTIVE_ADMIN` remains visible with its public message/request ID and does not mutate the row.
- Added an explicit server-side role guard for `/admin`: anonymous users preserve `/admin` in the login return route, members are redirected without admin content, and administrators receive the workspace. Next.js remains responsible for applying the configured `/fitgrid` base path exactly once.

## TDD Evidence

- RED: `pnpm exec vitest run src/features/admin src/app/base-path-routing.test.tsx`
  - Four suites failed because `admin-api`, `use-admin-users`, `admin-workspace`, and the protected admin page did not exist.
- GREEN: the focused administrator and route suite passed with 43 tests.
- Expanded focused gate: administrator tests plus AppShell and route tests passed with 56 tests.

## Verification

- `pnpm test`: 62 files passed, 1 environment-gated integration file skipped; 501 tests passed, 1 skipped.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with no warnings or errors.
- `NEXT_BASE_PATH=/fitgrid pnpm build`: passed; the route manifest contains `basePath: /fitgrid` and the build includes `/admin` plus all three administrator API routes.
- `NEXT_BASE_PATH=/fitgrid pnpm exec vitest run src/e2e/ui-demo.smoke.test.ts`: passed.
- Production runtime bundle scan: no `demo-admin-data`, demo user names, demo invitation tokens, or demo error IDs were found in runtime JS. A server sourcemap retains only the source-level development import specifier, not demo data or an executable demo module.

## Interactive Browser Smoke

- Desktop `1440 × 900`: rendered three deterministic users, all five allowed columns, no product text, and a disabled self-lockout action.
- Invitation creation produced one current URL and Clipboard success only after the copy operation completed.
- Status confirmation set `aria-modal`, focused Cancel, hid/inerted outside header/navigation, locked body scrolling, updated the target row from the adapter response, closed, and restored document state.
- Mobile `390 × 844`: body width matched the viewport, navigation remained in normal top flow (`position: static`), and the dense ledger used its own horizontal scroll region (`364px` client width, `720px` content width) without a bottom navigation bar.

## Scope

Only Task 4 implementation, tests, protected admin routing, styles, and this report were changed. Existing server administrator routes/services remained authoritative and required no modification.
