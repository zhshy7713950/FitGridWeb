# FitGrid price alerts implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved plan task by task. The user explicitly requested implementation; do not repeat the design approval gate.

**Goal:** Add authenticated price and dynamic daily-MA alerts with free minute primary/fallback feeds, Bark delivery, and VPS-safe scheduling.

**Architecture:** Existing Next.js process, PostgreSQL owner RLS, host systemd timer invoking a private route. No extra service or runtime dependency. Existing grid/Android contracts stay compatible.

**Tech stack:** TypeScript, Next.js, React, Prisma/PostgreSQL, Decimal.js, Node Fetch/crypto, systemd/nginx.

**Spec:** User-approved “FitGrid 股价预警正式版 V1 开发设计” in this conversation; acceptance summary below.

## Global constraints

- 50 distinct instruments / 250 rules capacity; CN stocks/ETFs and US stocks/ETFs only.
- Ten completed 1m OHLC bars every 10m at boundary+15s; final segment fetch+30s expires+60s. Regular sessions only, published calendars, unknown years fail closed.
- Price, MA touch (selectable direction), MA percent; MA uses prior N−1 adjusted closes plus candidate price. N2–250, M0.01–99.99; equality counts.
- Minute close outside rearms; one event/minute; one notification/rule/batch. Activation starts first full future minute; edits invalidate old pending delivery.
- Primary failure/incompleteness immediately invokes complete backup; no fabricated or combined bars, no stale-cache alerts. MA fallback includes same-provider adjusted daily history.
- Preserve state on gaps; bounded 30m same-segment backfill, no closed-hours requests. Persistent dedup and finite Bark retries with encrypted per-owner keys.
- Preserve existing memory limits and maintenance fences; v4 portable backup, v3 restore compatibility, no keys/outbox/cache in portable archive, restored alerts paused.

## Review focus

- A minute touches and closes outside: rearm only after this minute; no intra-minute ordering invented.
- Primary minute data works while daily basis fails: price rules use primary; MA rules attempt a complete backup pair.
- Edit/disable races: state/events/outbox commit atomically against current rule, channel and user versions.
- Restart/closed boundary: dedup queued jobs and never start a source request outside allowed session/deadline.
- Restore: paused rules and discarded pending sends; legacy grid/Android exports unchanged.

## Task 1: Domain, calendar and market adapters

Files: `src/server/price-alerts/{types,engine,calendar,market-data}.ts` and focused tests.
Interfaces: normalized Instrument, MinuteBar, DailyBasis, AlertCondition; evaluateBars returns updated cursor/latch and events; calendar returns due windows; market adapters return validated complete provider windows.
- [x] Write/run failing behavior tests for exact thresholds, MA candidate math, rearm/activation/gaps, sessions/DST/close, malformed/incomplete/stale provider data and local HTTP timeouts/fallback.
- [x] Implement minimal engine/calendar/adapters with bounded concurrency, fetch size/timeout and provider identity validation.
- [x] Run focused tests and typecheck; record results in execution ledger.

## Task 2: Persistent rules, channels and delivery

Files: Prisma additive migration/schema, `src/server/price-alerts/{repository,service,bark}.ts`, runtime services and route handlers.
Interfaces: owner-scoped rule CRUD with expectedVersion, encrypted/tested channel, atomic evaluate/commit, idempotent outbox claim/finish; service exposes cached DTOs only on reads.
- [x] Write/run failing service, actual local Bark HTTP and PostgreSQL RLS/transaction tests.
- [x] Implement tables/RLS, encryption, revision invalidation, CRUD and authenticated routes; update runtime services and admin disable handling.
- [x] Generate Prisma client, run focused tests and contract/type checks.

## Task 3: Durable scheduler and maintenance-safe host activation

Files: `src/server/price-alerts/{scheduler,runtime}.ts`, private route, timer/script templates and installer/maintenance changes.
Interfaces: tick returns bounded scan/delivery status; no caller-provided owner or target URL. Job advisory lock uses a dedicated connection outside DB transactions.
- [x] Write/run failing controlled-clock tests for closed sessions, cleanup once/deadlines/restart/gap recovery, retries and 50-product shared scans.
- [x] Implement durable scans, bounded backfill, shared feed requests and outbox; protect internal route and enforce maintenance fences.
- [x] Add systemd integration, generated independent secrets, nginx private-prefix rejection; execute installer script tests.

## Task 4: Responsive authenticated pages

Files: `src/features/price-alerts/*`, protected app pages, navigation/return paths, grid detail entry.
Interfaces: list → detail → edit, independent channel settings, cached price/source/time and per-event delivery state; never expose secrets or request feeds on refresh.
- [x] Write/run failing UI/API client tests for rule forms, directions, pause/resume/version conflict, detail/login links and channel masking.
- [x] Implement approved mobile cards and existing desktop styles, errors/empty states, safe navigation and grid prefill.
- [x] Run UI tests; inspect mobile/desktop screenshots with production-like fixtures.

## Task 5: Backup, docs and final verification

Files: canonical portable backup/restore pipeline and tests, OpenAPI, deployment guide.
- [x] Write/run failing v3/v4 backup/restore tests for referenced instruments/rules/history, no key/cache/outbox export, paused restored state and no replay.
- [x] Implement version compatibility, retention/diagnostics and upgrade/rollback/acceptance documentation.
- [x] Run full tests, typecheck, lint, production build, real DB integration and available memory/container checks. Report unavailable VPS/iPhone evidence explicitly.
- [x] Request one fresh whole-change review, fix important findings with regression tests, rerun required checks.

## Local completion status

All five implementation tasks and available local verification are complete as of 2026-10-28. The VPS/iPhone, live full-session feeds, corporate-action semantics and container resource checks remain explicit release gates in `docs/price-alerts-verification.md`; no production acceptance is claimed.

## Execution ledger

Progress is recorded in `docs/superpowers/plans/2026-10-27-price-alerts-progress.md`. No push, merge or production deployment is implied. VPS calendar/full-session/US ETF and iPhone acceptance remain release gates.
