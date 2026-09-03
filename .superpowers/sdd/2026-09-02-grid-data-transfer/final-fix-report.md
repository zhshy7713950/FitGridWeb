# Grid data transfer final-fix report

## Result

- Base: `9ea384c`
- Commit subject: `fix: close data transfer review gaps`
- Scope: data-transfer final review only; account/admin work was not started.

## Findings addressed

1. `POST /grid-trades/import/commit` now documents its actual unusable-preview `404` and owner-mutation rate-limit `429`. The 404 reuses the shared `NotFound` response and names `IMPORT_PREVIEW_NOT_FOUND`; the 429 reuses `RateLimited`, including its `Retry-After` header contract.
2. The runtime semantics already matched those shared schemas and were left unchanged. `ImportService.commit` throws `ApiError(404, "IMPORT_PREVIEW_NOT_FOUND", ...)`; `ownerMutationRequests.consume` can throw `ApiError(429, "RATE_LIMITED", ...)`; `apiHandler` serializes both through the shared `ErrorResponse` envelope, and the limiter supplies `Retry-After`.
3. The browser smoke no longer deletes every remaining seeded product through approximately 23 serial detail/delete navigations. It retains the created-product delete flow and the seeded-product delete/recalculate flow, while the reliable `GridWorkspaceView` component test remains the account-empty-state coverage.
4. Heading-level browser coverage now verifies the app-relative import link and opens the backup dialog to verify both Android-compatible and Web-complete download actions. No test-only production seam or backdoor was added.

## TDD evidence

The new OpenAPI contract test was added before the document change. Its first run failed because the import commit 404 response was absent:

```text
pnpm exec vitest run src/server/http/api-contract.test.ts
Test Files  1 failed (1)
Tests       1 failed | 1 passed (2)
received undefined for responses["404"]
```

After documenting both responses, focused runtime and contract coverage passed:

```text
pnpm exec vitest run src/server/http/api-contract.test.ts src/server/import-export/import-service.test.ts src/server/security/request-protection.test.ts
Test Files  3 passed (3)
Tests       9 passed (9)
```

A mutation check then removed only the 429 declaration. The contract test failed specifically on `responses["429"]`; restoring it returned the contract file to 2/2 passing. Together with the initial 404 RED run, removing either response is proven to fail.

## Focused browser and component gate

```text
pnpm exec vitest run src/server/http/api-contract.test.ts src/server/import-export/import-service.test.ts src/server/security/request-protection.test.ts src/features/grids/grid-workspace.test.tsx src/e2e/ui-demo.smoke.test.ts
Test Files  5 passed (5)
Tests       28 passed (28)
Duration    12.69s
```

The prior browser-only baseline took 20.20 seconds on this host. After removing the product-draining loop, the real base-path smoke passed:

```text
NEXT_BASE_PATH=/fitgrid pnpm exec vitest run src/e2e/ui-demo.smoke.test.ts
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    14.81s
```

## Full release gate

```text
pnpm test
Test Files  55 passed | 1 skipped (56)
Tests       377 passed | 1 skipped (378)
exit 0
```

The single skip is the expected PostgreSQL-gated integration test without `TEST_DATABASE_URL`.

```text
pnpm typecheck
$ tsc --noEmit
exit 0
```

```text
pnpm lint
$ eslint .
exit 0
```

```text
NEXT_BASE_PATH=/fitgrid pnpm build
Compiled successfully
TypeScript finished
19/19 static pages generated
exit 0
```

The route table includes `/grid-trades/import/commit`, `/grids/import`, and the existing grid workflow routes.

## Production bundle audit

The exact demo-data marker scan covered `demo-grid-not-found`, `demo-product-code-conflict`, `demo-grid-created-`, `黄金 ETF`, and `法国 CAC40 ETF` under `.next/static`. `rg` exited `1` with no output, meaning zero matches. This fix introduced no demo adapter or production-visible testing path.

## Self-review

- Contract changes target only the import commit operation and reuse existing shared response components.
- Runtime status, code, message, response-envelope, and rate-limit header behavior were inspected and not changed to fit the document.
- Browser coverage remains valuable but no longer depends on exhausting a mutable seed repository.
- Empty-account behavior remains protected by the component test that checks create, import, backup, and search-empty distinctions.
- No account/admin files, production API behavior, demo data, or client-side calculation code changed.
- `next-env.d.ts` was restored after build/dev generation, and `git diff --check` passed.
