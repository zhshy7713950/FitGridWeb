# FitGridWeb Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete FitGridWeb server defined by the replication baseline: authenticated owner-scoped grid CRUD, Android-compatible calculation/import/export, administration, invitations, health checks, PostgreSQL RLS, and deployment assets.

**Architecture:** A Next.js 16 modular monolith exposes `/api/v1` route handlers. Pure TypeScript domain and application modules own validation and business behavior; Prisma 7 owns PostgreSQL persistence; Better Auth 1.7 owns credential hashing and database-backed sessions. Every grid transaction sets `app.current_user_id`, and PostgreSQL FORCE RLS provides a second isolation boundary.

**Tech Stack:** Node.js 22, TypeScript 5, Next.js 16.3.4, React 19.2.8, Prisma 7.10.0, PostgreSQL 17, Better Auth 1.7.2, Decimal.js 10.6.0, Zod 4.5.4, Vitest 4.1.11, pnpm 11.

**Spec:** `docs/fit-replication/README.md` and the linked `02`–`08` specifications/contracts.

## Global Constraints

- Android behavior baseline is commit `a6452ac`, tag `v2.1.0`; do not modify `FitProj`.
- The only initial algorithm version is exactly `android-v2.1.0`.
- Business decimal values are JSON strings and must never be calculated with JavaScript `number`.
- Derived grid rows and totals are computed on demand and are never persisted.
- `ownerId` is accepted only from the authenticated server session, never from a DTO, cursor, import file, or route parameter.
- PostgreSQL `grid_trades` uses both an owner-scoped repository and FORCE RLS.
- Cross-owner grid IDs return the same 404 response as unknown IDs.
- Better Auth uses its standard database-backed `session.token` field, as explicitly approved on 2026-09-01; invitation tokens remain digest-only.
- Import files are limited to 10 MiB and 5,000 records; calculated output is limited to 10,000 rows.
- API errors use `{ code, message, fieldErrors?, requestId }`; logs never contain passwords, cookies, invitation tokens, import bodies, or product details.

---

### Task 1: Server Toolchain and Baseline Alignment

**Files:**
- Create: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `eslint.config.mjs`, `src/app/layout.tsx`, `src/app/page.tsx`
- Modify: `.gitignore`, `README.md`, `docs/fit-replication/05-web-target-architecture.md`
- Test: `src/server/smoke.test.ts`

**Interfaces:**
- Produces: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and the `@/* -> src/*` alias used by every later task.

- [ ] **Step 1: Add a failing smoke test**

```ts
import { describe, expect, it } from "vitest";
import { serviceIdentity } from "@/server/service-identity";

describe("serviceIdentity", () => {
  it("identifies the v1 FitGridWeb service", () => {
    expect(serviceIdentity()).toEqual({ name: "fitgridweb", apiVersion: "v1" });
  });
});
```

- [ ] **Step 2: Install the pinned dependency set and verify RED**

Run: `pnpm install && pnpm vitest run src/server/smoke.test.ts`

Expected: FAIL because `@/server/service-identity` does not exist.

- [ ] **Step 3: Add the minimal service identity and configuration**

```ts
export function serviceIdentity() {
  return { name: "fitgridweb", apiVersion: "v1" } as const;
}
```

Update the architecture document so Better Auth's standard `session.token` is the approved exception while invitation tokens remain SHA-256 digests.

- [ ] **Step 4: Verify the toolchain**

Run: `pnpm test && pnpm typecheck && pnpm lint`

Expected: all commands pass.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json next.config.ts vitest.config.ts eslint.config.mjs src README.md .gitignore docs/fit-replication/05-web-target-architecture.md
git commit -m "build: scaffold FitGridWeb server"
```

### Task 2: Android v2.1.0 Grid Domain

**Files:**
- Create: `src/server/grid-domain/types.ts`, `src/server/grid-domain/errors.ts`, `src/server/grid-domain/validation.ts`, `src/server/grid-domain/calculate-grid.ts`, `src/server/grid-domain/index.ts`
- Test: `src/server/grid-domain/calculate-grid.test.ts`, `src/server/grid-domain/validation.test.ts`
- Read fixture: `docs/fit-replication/fixtures/grid-algorithm-v2.1.0.json`

**Interfaces:**
- Produces: `validateGridInput(input: unknown): GridTradeInput`, `calculateGrid(input: GridTradeInput): GridCalculationResult`.
- Errors: `GridDomainError` with stable codes from the fixture's `webValidationCases` plus `ALGORITHM_VERSION_UNSUPPORTED`.

- [ ] **Step 1: Write failing golden-fixture tests**

For every fixture case, map Android numeric inputs to decimal strings and assert all item fields and totals against literal fixture values converted to canonical decimal strings. Assert the production change “wrong rounding point, row order, long/short branch, keep calculation, or total formula” would fail at least one case.

- [ ] **Step 2: Run golden tests and verify RED**

Run: `pnpm vitest run src/server/grid-domain/calculate-grid.test.ts`

Expected: FAIL because `calculateGrid` does not exist.

- [ ] **Step 3: Implement the minimal Decimal.js algorithm**

Use `Decimal.ROUND_HALF_UP`; define `R2`, `R3`, `R4`, and `Q` as private helpers. Long rows merge by descending gear and grid type `1,2,3`; short rows iterate from `floor(maxAmplitude / gearAmplitude)` to zero. Return decimal strings without exponential notation.

- [ ] **Step 4: Write and verify failing validation tests**

Use every `webValidationCases` entry plus unknown fields, exponential strings, precision overflow, negative integer fields, and short-mode normalization. Expected failures use the exact documented code.

- [ ] **Step 5: Implement strict validation and verify GREEN**

Run: `pnpm vitest run src/server/grid-domain`

Expected: all domain tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/grid-domain
git commit -m "feat: implement Android v2.1.0 grid domain"
```

### Task 3: API Errors, Request IDs, Signed Cursors, and DTO Parsing

**Files:**
- Create: `src/server/http/api-error.ts`, `src/server/http/json-response.ts`, `src/server/http/request-context.ts`, `src/server/security/signed-token.ts`, `src/server/grid-application/dto.ts`
- Test: `src/server/http/json-response.test.ts`, `src/server/security/signed-token.test.ts`, `src/server/grid-application/dto.test.ts`

**Interfaces:**
- Produces: `ApiError`, `toErrorResponse(error, requestId)`, `withRequestContext(handler)`, `signScopedToken(payload, secret)`, `verifyScopedToken(token, secret)`, `parseGridCreate`, `parseGridUpdate`.
- Cursor payload: `{ ownerId: string; sortOrder: number; createdAt: string; id: string; exp: number }`.

- [ ] **Step 1: Write failing tests for stable error envelopes and request IDs**

Assert a Zod field failure becomes status 422 with `VALIDATION_FAILED`, field errors, and the caller's legal request ID; illegal IDs are replaced with a generated ULID-like value.

- [ ] **Step 2: Implement errors and request context; verify GREEN**

Run: `pnpm vitest run src/server/http`

- [ ] **Step 3: Write failing token tests**

Cover valid round trip, payload tampering, wrong secret, expiry, and owner mismatch. A token must be base64url payload plus HMAC-SHA256 signature and use constant-time comparison.

- [ ] **Step 4: Implement signed tokens and strict DTOs; verify GREEN**

DTO schemas use `additionalProperties: false` semantics through strict Zod objects. Update DTOs require `expectedUpdatedAt`; neither schema contains `ownerId` or `algorithmVersion`.

Run: `pnpm vitest run src/server/security src/server/grid-application/dto.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/server/http src/server/security src/server/grid-application/dto.ts src/server/grid-application/dto.test.ts
git commit -m "feat: add secure API boundary primitives"
```

### Task 4: Prisma Schema, Migration, and Owner-Scoped Persistence

**Files:**
- Create: `prisma.config.ts`, `prisma/schema.prisma`, `prisma/migrations/20260901000100_initial/migration.sql`, `src/generated/prisma/*`, `src/server/db/client.ts`, `src/server/grid-persistence/types.ts`, `src/server/grid-persistence/prisma-grid-trade-store.ts`
- Test: `src/server/grid-persistence/prisma-grid-trade-store.integration.test.ts`

**Interfaces:**
- Produces: `withOwnerScope<T>(ownerId, fn)`, `OwnerScopedGridTradeStore` with `list`, `findById`, `findByProductCode`, `create`, `update`, `delete`, and `all`.
- Consumes: validated `GridTradeInput` and signed cursor payloads.

- [ ] **Step 1: Write the PostgreSQL integration test contract**

Create users A/B and same-code grids; assert same-owner conflict, cross-owner coexistence, list/search isolation, foreign UUID 404 behavior at the store boundary, signed cursor binding, optimistic update conflict, and a raw Prisma query blocked by FORCE RLS. Skip only when `TEST_DATABASE_URL` is absent and print the exact reason.

- [ ] **Step 2: Add schema and SQL migration**

Models: Better Auth `User`, `Session`, `Account`, `Verification`; `Invitation`; `GridTrade`; `ImportPreview`. Use UUID primary keys, `(ownerId, productCode)` uniqueness, stable pagination index, `numeric(30,10)`, and no derived grid columns. SQL creates `pgcrypto`, enables/forces RLS, creates owner policies, and ensures the runtime role has no `BYPASSRLS`.

- [ ] **Step 3: Generate Prisma Client and verify compile failure is resolved**

Run: `pnpm prisma generate && pnpm typecheck`

- [ ] **Step 4: Implement the transaction-closed owner store**

`withOwnerScope` must call `SELECT set_config('app.current_user_id', $1, true)` inside the same interactive transaction used by every query. Do not export a general-purpose `PrismaClient` from the grid persistence module.

- [ ] **Step 5: Run available verification**

Run: `pnpm vitest run src/server/grid-persistence/prisma-grid-trade-store.integration.test.ts`

Expected without PostgreSQL: one explicit environment skip. Expected with PostgreSQL: all isolation tests pass.

- [ ] **Step 6: Commit**

```bash
git add prisma.config.ts prisma src/generated src/server/db src/server/grid-persistence
git commit -m "feat: add owner-scoped PostgreSQL persistence"
```

### Task 5: Grid CRUD Application Service

**Files:**
- Create: `src/server/grid-application/grid-service.ts`, `src/server/grid-application/in-memory-grid-store.ts`
- Test: `src/server/grid-application/grid-service.test.ts`

**Interfaces:**
- Produces: `GridService.list/get/create/update/delete/recalculate` taking an authenticated owner ID and store factory.
- Returns: OpenAPI-shaped `GridTradeSummary`, `GridTradePage`, and `GridTradeDetail` without owner fields.

- [ ] **Step 1: Write failing application tests against the in-memory owner-scoped store**

Cover FUN-01 through FUN-09 and SEC-01 through SEC-05/SEC-09: stable pagination, search, create conflict, edit retaining its own code, optimistic conflict, physical deletion, recalculation idempotence, and cross-owner 404.

- [ ] **Step 2: Implement minimal CRUD orchestration**

All create/update inputs pass through domain validation; short inputs are normalized before storage; calculations occur after reads and writes; Prisma uniqueness maps to `PRODUCT_CODE_CONFLICT`; stale `expectedUpdatedAt` maps to `EDIT_CONFLICT`.

- [ ] **Step 3: Verify GREEN and refactor**

Run: `pnpm vitest run src/server/grid-application/grid-service.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/server/grid-application
git commit -m "feat: add owner-scoped grid application service"
```

### Task 6: Better Auth, Invitations, and Account Administration

**Files:**
- Create: `src/server/auth/auth.ts`, `src/server/auth/session.ts`, `src/server/auth/user-policy.ts`, `src/server/invitations/invitation-service.ts`, `src/server/admin/admin-service.ts`, `src/server/cli/create-admin.ts`
- Test: `src/server/auth/user-policy.test.ts`, `src/server/invitations/invitation-service.test.ts`, `src/server/admin/admin-service.test.ts`

**Interfaces:**
- Produces: Better Auth `auth`, `requireSession(headers)`, `requireAdmin(headers)`, `InvitationService`, `AdminService`, and `pnpm admin:create`.
- User fields: normalized immutable `username`, `role: member|admin`, `status: active|disabled`; an internal deterministic `.invalid` email satisfies Better Auth without exposing email as a product feature.

- [ ] **Step 1: Write failing policy and invitation tests**

Cover username/password limits, token entropy/digest-only storage, 24-hour default/168-hour maximum, status without metadata leakage, one-time consumption, same-transaction user/account/invitation mutation, duplicate username conflict, and disabled-user login denial.

- [ ] **Step 2: Configure Better Auth**

Use Prisma adapter, username plugin with 3–64 lowercase normalization and immutable usernames, standard database session tokens, seven-day expiry/one-day rolling update, secure production cookie attributes, disabled public sign-up/email sign-in/enumeration endpoints, and a session-create hook rejecting disabled users.

- [ ] **Step 3: Implement transactional invitation acceptance**

Use the same password hash/verify functions configured in Better Auth so invitation acceptance can create `User` and credential `Account` and set `usedAt/usedById` in one Prisma transaction.

- [ ] **Step 4: Implement admin behavior and CLI**

Account listing exposes no grid counts. Disabling revokes all sessions. Reject disabling the final active admin. The CLI reads the password from a masked TTY prompt, rejects arguments containing a password, and only succeeds when no users exist.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm vitest run src/server/auth src/server/invitations src/server/admin`

- [ ] **Step 6: Commit**

```bash
git add src/server/auth src/server/invitations src/server/admin src/server/cli package.json
git commit -m "feat: add private account and invitation services"
```

### Task 7: Android Import Preview/Commit and Both Export Formats

**Files:**
- Create: `src/server/import-export/strict-json.ts`, `src/server/import-export/android-normalizer.ts`, `src/server/import-export/import-service.ts`, `src/server/import-export/export-service.ts`
- Test: `src/server/import-export/strict-json.test.ts`, `src/server/import-export/android-normalizer.test.ts`, `src/server/import-export/import-service.test.ts`, `src/server/import-export/export-service.test.ts`
- Consume: `docs/fit-replication/contracts/android-grid-trade.schema.json`, `docs/fit-replication/contracts/web-backup.schema.json`

**Interfaces:**
- Produces: `previewImport(ownerId, bytes)`, `commitImport(ownerId, previewToken, policy)`, `exportAndroid(ownerId)`, `exportWebBackup(ownerId)`.

- [ ] **Step 1: Write failing strict JSON and normalization tests**

Cover malformed UTF-8/JSON, duplicate keys, non-finite/exponent-overflow values, 10 MiB/5,000 limits, v2/v3/v4 defaults, blank-to-null normalization, ignored derived fields with warnings, file duplicate codes, and short-mode normalization.

- [ ] **Step 2: Implement strict parsing and Android/Web normalization**

The parser must reject duplicate object keys before ordinary JSON parsing. Decimal numbers are captured from source text so values are not rounded through JavaScript `number` before conversion.

- [ ] **Step 3: Write failing preview/commit isolation tests**

Cover creates/conflicts/invalid groups, digest-only 256-bit preview token, 15-minute expiry, owner binding, one-time commit, skip/overwrite, stable ID/createdAt on overwrite, invalid exclusion, and all-or-nothing rollback.

- [ ] **Step 4: Implement import transactions and both exporters**

Android export emits JSON numbers and regenerated rows without Web metadata. Web export emits strings, stable UUIDs/timestamps/version, and `ownerRef = hmac-sha256(HMAC(ownerId, OWNER_REF_SECRET))` without username or owner ID.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm vitest run src/server/import-export`

- [ ] **Step 6: Commit**

```bash
git add src/server/import-export
git commit -m "feat: add isolated import and export services"
```

### Task 8: `/api/v1` Route Handlers and Health Endpoint

**Files:**
- Create: `src/server/runtime/services.ts`, `src/server/http/route-factory.ts`
- Create: `src/app/api/v1/health/route.ts`, `src/app/api/v1/auth/login/route.ts`, `src/app/api/v1/auth/logout/route.ts`, `src/app/api/v1/auth/session/route.ts`, `src/app/api/v1/auth/change-password/route.ts`
- Create: `src/app/api/v1/invitations/[token]/route.ts`, `src/app/api/v1/invitations/[token]/accept/route.ts`, `src/app/api/v1/admin/invitations/route.ts`, `src/app/api/v1/admin/users/route.ts`, `src/app/api/v1/admin/users/[userId]/status/route.ts`
- Create: `src/app/api/v1/grid-trades/route.ts`, `src/app/api/v1/grid-trades/[id]/route.ts`, `src/app/api/v1/grid-trades/[id]/recalculate/route.ts`, `src/app/api/v1/grid-trades/import/preview/route.ts`, `src/app/api/v1/grid-trades/import/commit/route.ts`, `src/app/api/v1/grid-trades/export/route.ts`
- Test: `src/server/http/route-factory.test.ts`, `src/server/http/api-contract.test.ts`

**Interfaces:**
- Produces every operation in `contracts/openapi.yaml` with the documented status, response shape, content type, and authorization matrix.

- [ ] **Step 1: Write failing route-factory tests**

Invoke real `Request`/`Response` objects against injected in-memory services. Cover anonymous 401, member admin 403, cross-owner 404, strict unknown-field 422, 204 bodies, multipart size 413, ready 200, unavailable 503, and request ID propagation.

- [ ] **Step 2: Implement route factory and thin route files**

Route files perform no business calculation. They extract path/query/body/file data, require the correct session/role, call one application service method, and map errors through the common envelope.

- [ ] **Step 3: Run the OpenAPI contract test**

Validate the YAML and assert every documented operation ID maps to a route factory export and every emitted success/error body validates against its schema.

Run: `pnpm vitest run src/server/http && pnpm typecheck`

- [ ] **Step 4: Commit**

```bash
git add src/app/api src/server/http src/server/runtime
git commit -m "feat: expose FitGridWeb v1 server API"
```

### Task 9: Docker, Operations, and Final Verification

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `.env.example`, `ops/deploy.sh`, `ops/backup.sh`, `ops/restore.sh`
- Modify: `README.md`
- Test: `src/server/ops/config.test.ts`, shell syntax checks

**Interfaces:**
- Produces: immutable app image build, PostgreSQL 17 service, Caddy HTTPS proxy, migration-before-start deployment, interactive first-admin creation, encrypted verified backup, and guarded restore.

- [ ] **Step 1: Write failing configuration behavior tests**

Run scripts against temporary `.env` fixtures and fake command binaries. Assert missing/default secrets fail, deployment stops on migration failure, backups require dump/list/checksum/encryption success before retention cleanup, and restore rejects empty/default/production target URLs.

- [ ] **Step 2: Implement Docker and scripts**

Use POSIX-safe strict shell, quoted variables, explicit target validation, no secret echoing, fixed image tags, database health checks, and application runtime/migration role separation.

- [ ] **Step 3: Run complete verification**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build && sh -n ops/deploy.sh ops/backup.sh ops/restore.sh && git diff --check`

Expected: all locally runnable checks pass. If Docker/PostgreSQL are unavailable, report the exact unexecuted integration/operations checks rather than claiming them.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile docker-compose.yml Caddyfile .env.example ops README.md src/server/ops
git commit -m "ops: add production deployment and recovery assets"
```

### Task 10: Acceptance Traceability and Release Gate

**Files:**
- Create: `docs/fit-replication/server-implementation-status.md`
- Modify: test files as required by uncovered acceptance cases

**Interfaces:**
- Produces: mapping from FUN/ALG/DAT/SEC/OPS IDs to automated tests or explicit environment-gated manual checks.

- [ ] **Step 1: Map every server-side acceptance ID**

List each FUN, ALG, DAT, SEC, and OPS ID with its test file/test name. Mark browser-only visual behavior out of server scope and PostgreSQL/Docker checks environment-gated.

- [ ] **Step 2: Add tests for any uncovered server requirement**

Each added test must name the concrete production mutation it catches and must fail before the corrective implementation.

- [ ] **Step 3: Re-run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build && git diff --check && git status --short`

- [ ] **Step 4: Commit**

```bash
git add docs/fit-replication/server-implementation-status.md src
git commit -m "test: complete server acceptance traceability"
```

