# Price Alert Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Support verified 500-day dynamic MA, fail early on insufficient history, search real instruments for explicit confirmation, and expire temporary records after three days.

**Architecture:** Reuse market adapters and shared PostgreSQL caches. Put user-triggered history validation in PriceAlertService before owner-scoped writes; keep runtime validation and source pairing. Reuse existing editor styling and authenticated JSON API conventions.

**Tech Stack:** TypeScript, Next.js/React, Zod, Decimal.js, Prisma/PostgreSQL, Vitest.

**Spec:** docs/superpowers/specs/2026-10-28-price-alerts-expansion-design.md

## Global Constraints

- Days2–500; N−1 completed adjusted closes plus current minute price. Sources remain strict, bounded5s/2MB, owner-isolated.
- Preserve50 products/250 rules, memory limits, schedules, Bark, and original frontend/grid/backup formats.
- Confirmed3-day TTL only temporary records; events30days/max100000; do not delete active rules/owners/channel keys.
- No production mutation/deployment during implementation; use existing isolated local acceptance database.

## Review Focus

- Stale249-row cache vs genuine short listing history must not create a false maximum.
- Upstream timeout must not be reported as proven insufficient history; direct API enable/edits cannot bypass preflight.
- Weekend/after-close validation cannot seed an unverifiable future session cache or use unfinished daily closes.
- Similar-name indices/foreign exchanges and late async results cannot select an unintended security.
- Terminal queue retention uses acceptedAt or expiresAt, never deletes pending/sending or required event evidence.

---

### Task 1: 500-day adapters and save-time preflight

**Files:** src/server/price-alerts/{engine,market-data,service,scheduler}.ts; app/api/v1/price-alerts routes; matching tests; features/price-alerts/price-alert-form; schema contract/OpenAPI; diagnostics docs.
**Interfaces:** fetchSource(provider,product,window,requiredDays:number,basis,options); PriceAlertService.create(owner,input)/update(owner,id,input); fetchDailyBasis(provider,product,sessionDate,options):Promise<DailyBasis>.

- [x] Write RED tests for500/501,499 historical closes, extended URLs, oldshort-cache refresh, and source failure vs true short history; run focused Vitest and observe failure.
- [x] Add service create/update preflight tests covering requested300/available200→max201, fallback sufficient, timeout503, direct mutations, no preflight on price/pause/delete, scoped version checking and off-hours cache rules.
- [x] Implement minimal bounds/adapters/preflight/routes; keep network outside transactions. Update OpenAPI/diagnostics and500 form copy with matching existing tests.
- [x] Verify focused engine/market/service/HTTP/schema/form suites and real PG alert integration, typecheck; record exact outcomes.
- [x] Commit Task1 after required checks; record progress in ledger.

### Task 2: Real instrument search and explicit confirmation

**Files:** src/server/price-alerts/instrument-search.ts and tests; service/types; new app/api/v1/market/instruments/search/route.ts; features/price-alerts/{types,price-alert-api,price-alert-pages,demo-price-alerts} and tests; existing OpenAPI.
**Interfaces:** InstrumentCandidate{code,name,market,currency,kind,exchange}; searchInstruments(market,query,options):Promise<InstrumentCandidate[]>; service.search(market,query); alertApi.search(market,query):Promise<{items:InstrumentCandidate[]}>. Confirmation continues to alertApi.resolve.

- [x] RED tests with captured Tencent/Yahoo samples and real localHTTP transport: code/name results, Unicode, unsupported index/foreign/duplicates/empty/invalid HTTP, exact suffix filter.
- [x] Implement fixed-origin, bounded, safely parsed live search and authenticated/rate-limited endpoint; contract fixtures and API tests.
- [x] RED UI/API tests: search then explicit confirmed choice, invalidate on edits, loading/error/empty states, late results ignored, existing fullcode/grid prefill and demo behavior.
- [x] Implement candidate list in existing editor style and re-resolve on confirmation; run focused frontend/API/schema suites and inspect browser/mobile view.
- [x] Commit Task2 and record progress.

### Task 3: Three-day temporary retention and integrated verification

**Files:** scheduler.ts and scheduler.integration.test.ts; docs/price-alerts.md and verification/research records.
**Interfaces:** existing daily cleanup only; persisted schemas unchanged.

- [x] RED PG tests for3day cutoff, recently accepted terminal queue with oldcreatedAt retained, oldterminal removed, pending/sending retained, daily snapshots olderthan3days removed vs499-price history retained,30day events/active rules unchanged; run and observe failures.
- [x] Implement bounded cleanup with72h cutoff and recent2 daily snapshots; update user-facing operational docs.
- [x] Run full serial local suite with restricted TEST_DATABASE_URL and MIGRATION/TEST_CONTROL URLs, /fitgrid prefix and30s test budget; typecheck/lint/build; live daily/search spot checks.
- [x] Independent whole-change review against59d26cc and spec; fix Important findings with RED→GREEN, rerun affected/full verification as needed.
- [x] Commit final changes and report research, implemented behavior, validation, and target-environment limitations.
