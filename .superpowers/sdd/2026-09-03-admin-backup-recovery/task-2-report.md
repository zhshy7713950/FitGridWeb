# Task 2 Report: Host Maintenance Worker

## Summary

Implemented the root-owned, serialized maintenance worker for `backup`, `inspect-restore`, and `restore` jobs. The worker validates exact JSON schemas, derives every filesystem path from canonical UUIDs, atomically publishes public status, claims jobs before execution, creates immutable expiring prepared restores, snapshots production before stopping writes, clears restored Better Auth sessions, performs at most one rollback attempt, preserves maintenance mode after rollback failure, recovers safely after reboot, and writes redacted root-only JSONL audit records.

Base commit: `93414967760bcb34452bf4f4b25f32787fe02620`.

## Files

- `ops/lib/maintenance-jobs.sh`
  - Exact per-operation job parsing and canonical UUID/request-ID validation.
  - Atomic status and maintenance-marker publication with mode `0640`.
  - Root-only audit JSONL with stable event/status/error values and optional backup digest.
  - Derived secret/upload/prepared paths and cleanup.
  - Portable backup and inspection handlers.
  - Immutable `0400` prepared dump/manifest/challenge with a fixed UTC epoch expiry.
  - Production restore, migration, complete `sessions` deletion, health checking, encrypted rollback snapshot, and one rollback attempt.
  - Stale claimed-job and interrupted-maintenance recovery.
- `ops/maintenance-worker.sh`
  - Root-only entry point, environment validation, non-blocking host `flock`, reboot recovery, serialized inbox drain, and expiry sweep.
- `src/server/ops/maintenance-worker.test.ts`
  - Fifteen behavioral integration tests using the real worker and controlled fake host executables.

## TDD Evidence

### Initial RED

Command:

```text
pnpm test src/server/ops/maintenance-worker.test.ts
```

Observed before any production worker files existed:

```text
Test Files  1 failed (1)
Tests       14 failed (14)
sh: .../ops/maintenance-worker.sh: No such file or directory
```

The test file initially had a template-string parse error; that test-only error was corrected and the command was rerun until every test failed for the intended missing-worker reason shown above.

### Cleanup refinement RED/GREEN

The first implementation run produced 12 passing tests and two failures because a prepared directory set to `0500` could not be removed by the unprivileged test process. Cleanup was changed to restore owner write permission immediately before deleting a non-symlink prepared directory.

Additional regression cycles were observed:

- Actual Better Auth table name, restart-stable rollback failure, and independent expiry sweep: 3 failing / 12 passing, then green after implementation.
- Stale inbox passphrase cleanup: targeted run 1 failing / 1 passing, then 2 passing.
- Malformed-job upload cleanup and audit redaction: targeted run 1 failing, then 1 passing.

### Final focused GREEN

```text
pnpm test src/server/ops/maintenance-worker.test.ts
Test Files  1 passed (1)
Tests       15 passed (15)
```

Combined non-TTY operations coverage:

```text
pnpm test src/server/ops/maintenance-worker.test.ts src/server/ops/portable-backup.test.ts -t '^(?!.*(?:TTY|re-prompts)).*$'
Test Files  2 passed (2)
Tests       28 passed | 2 skipped (30)
```

The exact unprivileged combined command ran 28/30 tests successfully; its only two failures were the pre-existing pseudo-TTY cases blocked by the sandbox with `stty: TIOCGETD: Operation not permitted`. No related source or test was changed. The complete suite was therefore rerun with host process permissions:

```text
pnpm test
Test Files  65 passed | 2 skipped (67)
Tests       583 passed | 3 skipped (586)
```

Additional verification:

```text
pnpm typecheck  # exit 0
pnpm lint       # exit 0
sh -n ops/lib/maintenance-jobs.sh ops/maintenance-worker.sh  # exit 0
git diff --check  # exit 0
```

## Acceptance Coverage

- Serialization: two concurrent worker processes and two queued backups never exceed one fake host command at a time.
- Strict schemas and paths: invalid JSON, unknown type, malformed UUID, unexpected path/password fields, symlinks, filename/ID mismatches, and replaced prepared data cannot select host paths or commands.
- Claiming and atomicity: JSON is moved out of `inbox` before execution; every public status is written to a private temporary file, chmodded to `0640`, and renamed.
- Inspection: the upload is authenticated and validated by Task 1, then dump, manifest, digest, actor, request ID, and ten-minute epoch expiry are frozen under the root-only prepared directory.
- Restore order: prepared digest/readability check, verified encrypted rollback snapshot, maintenance marker, app stop, connection termination, production restore, migrations, all-session deletion, app start, local/public health checks.
- Rollback: application-health failure performs one rollback only; successful rollback clears maintenance and reports the original restore as failed with `rolledBack: true`; rollback failure reports `intervention-required`, keeps maintenance active, and is not retried after restart.
- Cleanup: passphrase files, uploads, prepared plaintext, partial work, and safely stale claimed jobs are removed on terminal paths. Interrupted in-maintenance restore jobs are quarantined for operator inspection without automatic continuation.
- Audit: records contain stable operation/status/error fields, validated IDs, timestamps, and digests only. Tests prove injected paths, passwords, database URLs, upload data, and command output are absent.

## Security Considerations

- Task JSON is parsed only with `jq`; no JSON value is evaluated as shell.
- Restore has no caller-supplied database URL or filesystem path. All Compose services, SQL actions, and health URLs are fixed from root-owned deployment configuration.
- The runtime database role is passed to `psql` as a variable rather than interpolated as SQL text.
- Rollback material is encrypted with the root-only server key and verified before application writes are stopped.
- Secrets are moved out of the web-visible inbox before use and never appear in argv, status, audit, stdout, or stderr.
- Prepared cleanup treats symlinks separately so it never chmods or recursively follows a substituted external directory.

## Residual Risks

- This task uses fake Docker/PostgreSQL/age/curl executables. The production-equivalent disposable Docker restore drill remains Task 7 work.
- Expiry cleanup occurs whenever the path-activated worker runs. A dedicated timer is not part of Task 2; an untouched expired prepared artifact remains inaccessible and is rejected on confirmation, then is deleted on the next worker invocation.
- An `intervention-required` result deliberately does not auto-clear maintenance or auto-retry. Operator diagnosis and manual recovery procedures remain Task 7 work.
