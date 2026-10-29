# ETF valuation execution ledger

Plan: 2026-10-29-etf-valuation-observation.md
Spec approved for implementation by user on 2026-10-29 (拉分支，并按这个方案开发).
Branch: codex/etf-valuation; isolated managed worktree.

## Pre-flight
- Tasks 1→2→3→4→5→6 share Observation/Series/DTO types; define once in types.ts.
- Task 7 verifies persistence and UI of Tasks 3/6. Existing research files remain read-only in original checkout.
- Ruling: execute locally without subagents; user did not request delegation.
- Ruling: reuse installed dependencies via workspace node_modules symlink; no package changes.

## Progress
- Task 1: complete — 9 mapping/source tests; 49 live probes: 41 success / 8 failed; archived inputs SHA256-verified.
- Task 2: complete — 6 mathematical/MA tests passed after observed RED.
- Task 3: complete — 3 real PostgreSQL integration tests; migration + generated client verified.
- Task 4: complete — 8 cache/cadence/resume/failure tests, archived dates preserved.
- Task 5: complete — authenticated routes, private headers, strict inputs, basePath client, OpenAPI route coverage.
- Task 6: complete — three charts, desktop/mobile entry, 120-second busy bound, sequential backfill, touch/keyboard inspection, direct route and login return tests; four fixture screenshots visually checked.
- Task 7: pending

Ruling: bootstrap verified archived values once on first refresh of an empty series, never in GET or at every startup — preserves usable free histories when upstream is currently 403 — captures remain explicitly dated, never claimed live.
Ruling: Prisma empty-update upsert raced on initial concurrent creation; replaced with native INSERT ON CONFLICT DO NOTHING, proven by a two-connection test.
Ruling: invoke installed JS CLIs directly because pnpm11 attempts to purge symlinked dependencies; project package versions remain unchanged.

Ruling: process at most four source batches per refresh because a global monthly source can use two HTTP requests; remains below the plan eight-request ceiling.
Ruling: pnpm_config_verify_deps_before_run=false permits standard pnpm checks with the shared dependency tree, without modifying project config.

## Resumed implementation (2026-10-29)
- Resumed the existing branch/worktree after the previous conversation failed; tasks 1–5 were retained.
- UI regressions observed RED→GREEN: busy state disables refresh and expires at 120 seconds; touch press selects a dated point. Additional sequential manual/due backfill and no automatic retry-on-error tests passed.
- PostgreSQL: repository + retention integration suites 5/5 passed on an isolated local PostgreSQL instance, including actual AlertScheduler cleanup and shared S&P500 cache with offline preservation.
- Live service: 510880 price/PE and 513650 price fully backfilled; VOO price unavailable, global PE and 510880 PB fell back to dated archives. Warm reads/due refresh issued zero upstream calls; offline refresh preserved every point.
- Whole-database pg_dump/pg_restore passed: 2000-12-29 observations, two revisions, latest value 12 and cursor 1999-12-31 survived restoration into a fresh temporary database.
- Ruling: replace the previous shared node_modules symlink with a frozen-lockfile offline installation inside this worktree — Turbopack rejects links outside its filesystem root; package versions and configuration are unchanged.
- Scope review is local; no reviewer subagent was dispatched because the user did not authorize delegation.
