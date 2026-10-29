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
- Task 4: pending
- Task 5: pending
- Task 6: pending
- Task 7: pending

Ruling: bootstrap verified archived values once on first refresh of an empty series, never in GET or at every startup — preserves usable free histories when upstream is currently 403 — captures remain explicitly dated, never claimed live.
Ruling: Prisma empty-update upsert raced on initial concurrent creation; replaced with native INSERT ON CONFLICT DO NOTHING, proven by a two-connection test.
Ruling: invoke installed JS CLIs directly because pnpm11 attempts to purge symlinked dependencies; project package versions remain unchanged.
