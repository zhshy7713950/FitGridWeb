# Dynamic Product Valuation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Search and verify new grid instruments, discover and persist valuation sources without per-symbol releases.
**Architecture:** Shared market identity, database valuation profiles, refresh-only discovery, capability-validated sources.
**Tech Stack:** Next.js, React, TypeScript, Prisma, PostgreSQL, Vitest.
**Spec:** docs/superpowers/specs/2026-11-09-dynamic-product-valuation-design.md

## Global Constraints
- Local isolated branch only; no production access, mutations or deployment.
- Preserve existing history keys, imports/exports and legacy grid parameters.
- No benchmark guesses from product display names; no arbitrary source URLs.

## Review Focus
- Canonical/raw-code duplicates and wrong exchange/currency.
- Metadata timeout, ambiguity, leveraged/inverse products and unavailable metrics.
- GET zero writes/network; ownership and maintenance before refresh.
- Database mapping persistence, backup compatibility and constrained provider requests.
- Search races, invalidated choices and legacy edits.

### Task 1: Dynamic identity and mapping
Files: valuation/product-discovery.ts, product-repository.ts, catalog.ts, sources.ts, Prisma migration and tests.
Interfaces: load/refresh ValuationProduct by canonical code; generate independent prices; metadata yields benchmark evidence.
- [x] Write and run failing tests for dynamic prices, QQQ metadata, ambiguity, constrained URLs and persistence.
- [x] Implement profile discovery/storage and capability validation, preserving old keys.
- [x] Run focused tests and typecheck.

### Task 2: Refresh and legacy grids
Files: valuation/service.ts, runtime/services.ts, valuation-page.tsx and tests.
Interfaces: profile read is local-only; refresh discovers metadata before history collection.
- [x] RED tests for uncatalogued QQQ, legacy raw codes, local GET, failed discovery and shared index history.
- [x] Implement and run GREEN tests including database roundtrip and backup compatibility.

### Task 3: Grid product picker
Files: grids/product-picker.tsx, grid-form.tsx, price-alerts search/resolve/types and contracts.
Interfaces: picker returns verified instrument; grid persists canonical code; legacy editing/import remains compatible.
- [x] RED tests for selection, stale results, unselected submit and LOF/REIT identification.
- [x] Implement and run GREEN.
- [x] Full suite, typecheck, lint, build, UI inspection (known baseline failure recorded in spec).

### Task 4: Review and finish
- [x] Fresh whole-branch review and meaningful regression fixes.
- [x] Record checks/limitations and commit feature branch; no push/merge/deploy.
