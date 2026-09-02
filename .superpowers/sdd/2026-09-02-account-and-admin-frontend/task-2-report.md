# Task 2 report — invitation registration

## Scope delivered

- Added the public `/invite/[token]` route outside the protected layout, with awaited Next.js 16 params.
- Added typed invitation status/acceptance APIs with exactly-once token encoding and `requestJson` error propagation.
- Added a development-only dynamic demo adapter. Its sole valid token is `valid-demo-invitation-token-000001`; every other demo token returns the public 404 shape.
- Added loading, valid, used, expired, invalid/404, retryable error, submitting, success, server field-error, and acceptance-time invalidation states.
- Enforced username 3–64, password 12–128, exact confirmation, synchronous duplicate locking, success-time password clearing, non-valid-state unmount/clearing, and `router.replace("/login")` without releasing the success lock.
- Changed administrator-created invitation URLs from `/accept-invitation/{token}` to same-origin `${APP_BASE_PATH}/invite/{token}` with the existing `/fitgrid` base-path allowlist.
- Updated the OpenAPI invitation URL description to match the public route.

## TDD evidence

The first focused RED run failed because the invitation client/page/route and `invitationUrl` helper did not exist, while the live admin route returned the old `/accept-invitation/...` URL. After adding the missing implementation, the focused gate passed. A later visual-path audit added a separate RED assertion showing that `../login` incorrectly resolved beneath `/invite`; replacing it with Next `Link href="/login"` made the test green and was browser-verified as `/fitgrid/login`.

Final focused result:

```text
Test Files  5 passed (5)
Tests       40 passed (40)
```

The invitation page test file now contains 19 cases; the final full-suite run includes them.

## Release gates

- `pnpm test`: 57 files passed, 435 tests passed, 1 PostgreSQL-gated file/test skipped.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with no warnings.
- `NEXT_BASE_PATH=/fitgrid pnpm build`: passed; route manifest includes `ƒ /invite/[token]`.
- Production marker scan of `.next/static` and `.next/server`: deterministic invitation demo token and demo request ID absent.
- `git diff --check`: passed.

The initial sandboxed full-suite baseline could not bind `127.0.0.1` (`EPERM`), while all non-browser suites passed. Re-running the same full gate with loopback permission produced the green result above.

## Browser smoke

- Desktop `/fitgrid/invite/valid-demo-invitation-token-000001`: valid heading, expiry, all three labeled inputs, and create action rendered.
- Mobile 390×844: one-column form, 390 px body width with no horizontal overflow, create action visible at 671 px, and no application bottom navigation.
- Invalid demo token: “邀请无效或已失效”, zero inputs, and a base-path-correct `/fitgrid/login` link.

## Security notes

- Password and confirmation exist only in the mounted React form state and request body; no UI storage, URL, or logging path was added.
- The form subtree unmounts whenever invitation state is non-valid, removing password state. Success explicitly clears both password fields before showing success and navigating.
- Production builds contain the real API path only; demo data remains behind the established `NODE_ENV`-guarded dynamic import boundary.
