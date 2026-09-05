# Maintenance Lifecycle Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Make backup and full-database restore maintenance jobs reliably release admission state, execute PostgreSQL connection termination correctly, and consume restore inspection state after a successful restore.

**Architecture:** Keep the fix inside the existing shell maintenance worker so the API contract and job files remain unchanged. Add behavior-level Vitest coverage around the worker harness, then build and deploy an amd64 image from the committed source while preserving the VM database and local HTTPS configuration.

**Tech Stack:** Bash, Node.js 22, Vitest, pnpm, Docker Compose, Lima x86_64 VM, PostgreSQL.

**Spec:** User-reported backup/restore failures and the maintenance lifecycle documented in `docs/fit-replication/low-memory-vps-runbook.md`.

## Global constraints

- Work only on `codex/fix-maintenance-lifecycle`, based on `origin/main`.
- Preserve the existing VM database, uploads, secrets, and local HTTPS/HTTP2 host configuration.
- Add regression tests before changing production behavior.
- Do not push or merge; create the local commit requested by the user.

### Task 1: Capture the three regressions in tests

**Files:**
- Modify: `src/server/ops/maintenance-worker.test.ts`

1. Add a test proving runtime-connection SQL is supplied to `psql` on stdin so named variables are expanded.
2. Add a test proving a normally completed maintenance job removes `active-job.json`.
3. Add tests proving terminal restore cleanup consumes the inspection status while the restore's intervention-required status remains available when needed.
4. Require newly generated dedicated nginx HTTPS vhosts to enable HTTP/2 for browser streaming uploads.
5. Run the focused tests and confirm the new assertions fail against the current implementation for the expected reasons.

### Task 2: Fix maintenance worker lifecycle behavior

**Files:**
- Modify: `ops/lib/maintenance-jobs.sh`
- Modify: `ops/lib/install-nginx.sh`

1. Send the connection-termination SQL through standard input instead of `psql --command`.
2. Reconcile admission after every non-intervention terminal job state, while preserving recovery state on failure.
3. Remove a successfully consumed restore inspection status during normal cleanup.
4. Enable HTTP/2 on newly generated dedicated HTTPS vhosts.
5. Treat inspection-status deletion and directory synchronization as retryable lifecycle operations that retain admission and root recovery state on failure.
6. Re-read the terminal status after persistence and require an affirmative non-intervention terminal state with no authoritative root intervention evidence before releasing admission.
7. Run the focused maintenance-worker and nginx test files and confirm they pass.

### Task 3: Run repository verification

**Files:**
- No production changes expected.

1. Run the maintenance-worker test file.
2. Run the relevant full test suite, typecheck, lint, and production build.
3. Review the diff for unrelated or generated changes.

### Task 4: Commit the verified fix

**Files:**
- Commit only the plan, tests, and maintenance worker changes.

1. Stage the intended files.
2. Create a local commit with a maintenance-lifecycle fix message.
3. Record the commit hash and confirm a clean worktree.

### Task 5: Rebuild and redeploy the x86_64 test environment

**Files:**
- Deploy from the committed Git archive into the Lima guest.
- Update the guest application release and image reference without modifying persisted state.

1. Archive the committed source and transfer it to the `fitgrid-amd64` VM.
2. Build an amd64 Docker image in the VM.
3. Back up the deployment metadata, install the release, and recreate application services while retaining volumes and `/var/lib/fitgridweb`.
4. Verify containers, worker service, database readiness, health endpoint, HTTPS page, deployed commit, and maintenance regression checks.
