# Task 1: Base-Path and Typed Browser API Foundation

## Implementation

- Added typed browser path contracts in `src/lib/app-paths.ts`: root/`/fitgrid` joining, API v1 paths, safe grid-only return paths, login/unauthorized routes, and browser unauthorized redirect handling.
- Added `requestJson` and `ClientApiError` in `src/lib/api-client.ts`. Requests are same-origin JSON requests; public error envelopes, positive `Retry-After`, 204 responses, and non-login 401 expiry callbacks are normalized.
- Configured Next.js to calculate its validated base path once and expose it to browser code as `NEXT_PUBLIC_APP_BASE_PATH`.
- Added the shared DOM test setup and the required DOM Testing Library dependencies while retaining Node as Vitest's default environment.
- Added the required malformed/non-JSON error regression: it asserts a 502 text response becomes a `ClientApiError` with only the public `REQUEST_FAILED` / `请求失败` fallback, without exposing the upstream response text.

## Files

- `next.config.ts`
- `package.json`
- `pnpm-lock.yaml`
- `vitest.config.ts`
- `src/test/setup.ts`
- `src/lib/app-paths.ts`
- `src/lib/app-paths.test.ts`
- `src/lib/api-client.ts`
- `src/lib/api-client.test.ts`

## RED evidence

```text
$ pnpm vitest run src/lib/app-paths.test.ts
FAIL  src/lib/app-paths.test.ts
Error: Cannot find module './app-paths'
Test Files  1 failed (1)
Tests  no tests
```

```text
$ pnpm vitest run src/lib/api-client.test.ts
FAIL  src/lib/api-client.test.ts
Error: Cannot find module './api-client'
Test Files  1 failed (1)
Tests  no tests
```

## GREEN evidence

```text
$ pnpm vitest run src/lib/app-paths.test.ts
Test Files  1 passed (1)
Tests  8 passed (8)
```

```text
$ pnpm vitest run src/lib/api-client.test.ts
Test Files  1 passed (1)
Tests  5 passed (5)
```

```text
$ pnpm vitest run src/lib/app-paths.test.ts src/lib/api-client.test.ts
Test Files  2 passed (2)
Tests  13 passed (13)
```

## Full-suite and typecheck evidence

```text
$ pnpm test
Test Files  31 passed | 1 skipped (32)
Tests  162 passed | 1 skipped (163)
```

```text
$ pnpm typecheck
$ tsc --noEmit
exit 0
```

## Self-review

- Verified every Task 1 API and configuration item against the task brief.
- Confirmed the non-JSON error path does not leak the response text and returns `ClientApiError` with public fallback values.
- Ran `git diff --check` with no whitespace errors.
- The initial sandboxed pnpm attempt created `.pnpm-store/`; it was removed before committing. It is not part of the task changes.
- Post-commit status evidence: `$ git status --short` produced no output. The working tree is clean.
