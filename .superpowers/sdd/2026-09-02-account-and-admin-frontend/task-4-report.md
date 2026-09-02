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

Only Task 4 administrator contracts, server status safety, client state/UI behavior, tests, protected routing, styles, and this report were changed.

## Repair Round 1: Concurrency and Error Safety

- Replaced the repository's split `find` / `countActiveAdmins` / `setStatus` / `revokeSessions` sequence with one `updateStatusAtomically` contract. `PrismaAdminRepository` now performs lookup, final-active-admin validation, status update, and disabled-user session deletion in one interactive PostgreSQL `Serializable` transaction.
- Added a bounded three-attempt retry for Prisma `P2034` serialization/write conflicts. On retry, the complete decision is re-read; a concurrent second administrator disable therefore resolves as `LAST_ACTIVE_ADMIN` instead of committing write skew. Session deletion commits or rolls back with the matching status transition.
- Added an in-memory concurrency contract proving two active administrators concurrently disabling each other yield one success and one `LAST_ACTIVE_ADMIN`, leave exactly one active administrator, and revoke only the successfully disabled account's sessions. Prisma mocks lock the Serializable boundary, last-admin no-write behavior, and bounded retry policy. A `TEST_DATABASE_URL`-gated PostgreSQL integration test covers the real two-transaction race and session consistency; it was skipped locally because no test database URL is configured.
- Changed account-list errors from flattened strings to structured public errors preserving the server `message`, `requestId`, `retryAfterSeconds`, `status`, and `code`. Initial and pagination 429 responses count down without polling the API and are synchronously blocked in the controller until the deadline. An initial or paginated 403 list response now shows “管理员权限未通过” and never simultaneously claims verified authority.
- Bound Clipboard completion to the current invitation version. A late success or failure for invitation A is ignored after invitation B replaces it, and a completion after unmount cannot set feedback, focus, or select a detached/new input.
- Extended the published OpenAPI responses: `POST /admin/invitations` includes 429; `PATCH /admin/users/{userId}/status` includes 409, 422, and 429. A parsed OpenAPI contract test locks all four additions.

### Repair TDD Evidence

- RED server: 6 failures demonstrated the old split repository protocol and absent atomic method; GREEN: 9 unit tests passed with the PostgreSQL integration test environment-gated.
- RED list/UI: 13 failures demonstrated flattened errors, missing Retry-After gating, misleading initial/paginated 403 authority, and stale Clipboard feedback/selection; GREEN: 36 hook/component tests passed.
- RED OpenAPI: the administrator 429 response was absent; GREEN: the parsed contract suite passed with 6 tests.
- Combined focused repair gate: 51 tests passed, 1 PostgreSQL integration test skipped because `TEST_DATABASE_URL` is not configured.

### Repair Verification

- `pnpm test`: 62 files passed, 2 environment-gated integration files skipped; 516 tests passed, 2 skipped. The first sandboxed attempt failed only because the UI smoke could not bind `127.0.0.1` (`EPERM`); the identical command passed when local loopback binding was permitted.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with no warnings or errors.
- `NEXT_BASE_PATH=/fitgrid pnpm build`: passed; the production build includes `/admin` and all administrator API routes and records `basePath: /fitgrid`.
- `NEXT_BASE_PATH=/fitgrid pnpm exec vitest run src/e2e/ui-demo.smoke.test.ts`: passed.
- Production runtime bundle scan over `.next/static` and `.next/server`: clean of `demo-admin-data`, demo administrator/member identifiers, invitation tokens, and demo error markers. `.next/dev` was intentionally excluded because the database-free smoke creates development-only demo chunks there.
