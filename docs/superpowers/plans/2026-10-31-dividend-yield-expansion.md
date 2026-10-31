# Dividend yield expansion implementation plan

> Execution: implement inline with TDD, review, verify and deploy as requested.

**Goal:** Add reliable index dividend yield charts for non-REIT products and deploy the verified image.

**Architecture:** Extend existing research series and cards, reuse persistence/statistics/refresh and REIT charts. No dependencies or schema migrations.

**Spec:** ../specs/2026-10-31-dividend-yield-expansion-design.md

## Task 1: Sources and cached histories

- [x] Add failing source/catalog tests: weekly dvRatio, monthly HSI, Multpl identity/columns/unit/estimates/future dates, unsupported products.
- [x] Extend types/catalog/sources with dividend_yield and weekly frequency. Extract one weekly sample per Monday-based UTC week in parsing and persisted reads; retain revisions.
- [x] Add real source archives and manifests (three weekly domestic, monthly HSI, Multpl). Validate SHA256 and actual output. Do not substitute mock data for source acceptance.
- [x] Verify: `pnpm exec vitest run src/server/valuation` (database integration separately when configured).

## Task 2: Service, API and UI

- [x] Add failing service/UI tests for cached/index/unsupported yields, source errors and REIT provenance remaining separate.
- [x] Return non-REIT dividendYield cards, reuse stats and refresh, render fourth chart with % and percentile values. Render provenance only for REIT.
- [x] Update demo, contract and page design. Verify service/UI/contract tests plus typecheck/lint/build.

## Task 3: Review, acceptance and release

- [x] Run real persistent database checks and desktop/390px light/dark browser checks. Source failures must be recorded.
- [ ] Independent review, fix important findings with regression tests. Run full suite and final checks.
- [ ] Commit, fast-forward main, push, wait Server image workflow success.
- [ ] Validated encrypted database backup; upgrade VPS immutable image; confirm image, health, stored real yield cards and existing REITs.

## Review focus

- Weekly partial-period dates across refreshes must not overweight percentiles, including Sunday/Monday at year boundaries.
- Source HTML drift/estimates must fail safely without clearing good saved data.
- Empty and unsupported histories must never become zero yield or fund distributions.
- Source subject/field/method and percent units must stay distinct from REIT TTM cash yields.
- Refresh budget/cooldown/ownership and stored-data-only GET must remain intact.

## Execution ledger

- Scope follows the user's direct implementation/deployment request; architecture and source choices stated in commentary. No additional approval gate.

- Task 1: source/catalog RED→GREEN; fixture checksums and parser/archive parity verified; 10 PostgreSQL integration tests passed. Live Legu HTTP403 recorded, Multpl HTTP200.
- Task 2: service/UI/contract RED→GREEN; 83 focused tests passed; typecheck/lint/build passed; four Chrome desktop/mobile theme tests passed.
- Final review: fresh independent reviewer, 39 targeted tests passed; no Critical/Important findings. Minor deferred: exact dvRatio calculation meaning needs new primary evidence; no inference or source blending made.
