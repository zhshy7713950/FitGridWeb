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

## Fix Round 1

### Summary

Addressed all seven findings from the review of `9341496..283f547`:

1. Rollback now stops the application and terminates runtime application-role connections before decrypting or applying rollback data. A quiescing failure performs no rollback restore and enters intervention.
2. Restore/rollback double failure retains the verified encrypted rollback snapshot with the claimed job in a root-only per-job intervention directory. Plaintext and verification files are always removed; successful restore or rollback removes the encrypted working copy.
3. Root state now fails closed unless paths are absolute and canonical, root-owned, non-symlink, and exactly owner-only mode. Prepared inputs are hard-linked into a unique root-only work directory, rehashed, revalidated, and restored only from that pinned inode.
4. Every terminal UUID is persisted as a root-owned `0400` completed record, and later publication of the same UUID is rejected even after ordinary job cleanup.
5. Derived inbox/claimed secrets and uploads are removed on rejection and terminal paths. A deterministic sweep removes artifacts that arrive late for an already-completed UUID. The publisher contract is documented as secret/upload first and atomic job rename last.
6. Marker and status atomic-renames are checked. A failed marker clear or terminal success publication cannot report success: maintenance is reasserted, intervention is published/audited, and the rollback snapshot is retained.
7. Restore challenges now always expire exactly 600 seconds after inspection; the environment cannot weaken or extend this bound.

Interrupted restore recovery was also aligned with the per-job intervention layout and preserves a present encrypted rollback snapshot while removing remaining plaintext work.

### Files Changed

- `ops/lib/maintenance-jobs.sh`
  - Added root ownership/mode/canonical-path validation, pinned prepared-dump claims, completed-ID replay records, orphan purging, rollback quiescing, intervention snapshot retention, checked finalization, and fixed challenge TTL.
- `ops/maintenance-worker.sh`
  - Added the deterministic terminal-orphan sweep.
- `src/server/ops/maintenance-worker.test.ts`
  - Added regression and failure-injection coverage for every review finding, including an actual pathname replacement after the hard-link claim.
- `.superpowers/sdd/2026-09-03-admin-backup-recovery/task-2-report.md`
  - Recorded this fix round and its evidence.

### TDD RED/GREEN Evidence

Each regression was run against the reviewed implementation before its production change, then rerun after the smallest corresponding change:

- Rollback quiescing: RED `2 failed`; the expected second stop/termination was absent and a forced rollback-quiesce failure incorrectly returned success. GREEN `2 passed`.
- Double-failure retention: RED `1 failed` because the per-job intervention directory did not exist. GREEN targeted double-failure and successful-rollback cleanup `2 passed`.
- Root trust and prepared race: RED `4 failed` for group-writable root, non-root ownership, non-canonical root, and pathname replacement. GREEN `4 passed`. A separately added pre-existing group-writable `claimed` regression was RED `1 failed`, then GREEN `1 passed` after removing permission repair of untrusted directories.
- Terminal UUID replay: RED `1 failed` because replay returned success. GREEN `1 passed`, including the root `0400` completed record and unchanged transition history.
- Late orphan cleanup: RED `1 failed` because a late secret remained. GREEN `1 passed`, with both late secret and upload removed on the next sweep.
- Marker/status failures: RED `2 failed`; one path published `succeeded` after marker-clear failure and the other left maintenance inactive after success-status failure. GREEN `2 passed`, both ending in auditable intervention.
- Fixed TTL: RED `1 failed` because an environment override produced 900 seconds. GREEN `1 passed` with exactly 600 seconds.
- Interrupted restore layout: RED `1 failed` against the former flat quarantine path. GREEN `1 passed` with a `0700` per-job directory and `0400` job record.
- Concurrent root-directory creation: the first full focused rerun was RED `24 passed / 1 failed` when one worker lost the `mkdir` race. GREEN targeted concurrency `1 passed` after making create-then-validate race-safe without repairing existing permissions.

Final focused commands before the final full-suite rerun:

```text
pnpm test src/server/ops/maintenance-worker.test.ts
Test Files  1 passed (1)
Tests       25 passed (25)

pnpm test src/server/ops/portable-backup.test.ts src/server/ops/maintenance-worker.test.ts
Test Files  2 passed (2)
Tests       40 passed (40)

pnpm typecheck  # exit 0
pnpm lint       # exit 0
sh -n ops/lib/maintenance-jobs.sh ops/maintenance-worker.sh  # exit 0
git diff --check  # exit 0
```

Final full-suite GREEN after all fix-round changes:

```text
pnpm test
Test Files  65 passed | 2 skipped (67)
Tests       593 passed | 3 skipped (596)

pnpm typecheck  # exit 0
pnpm lint       # exit 0
sh -n ops/lib/maintenance-jobs.sh ops/maintenance-worker.sh  # exit 0
git diff --check  # exit 0
```

### Concrete Invariant Choices

The review left room around how to make a prepared dump immutable without relying on Linux-only filesystem flags. The chosen portable invariant is: validate the root-owned `0400` source, hash it, create a hard link inside a unique root-owned `0700` work directory, revalidate and rehash the linked inode, and direct both `pg_restore --list` and the production restore from that link. Replacement before the link is detected by the second hash; replacement after the link cannot change the claimed inode. The regression physically replaces the original pathname after `ln` completes and proves the restore still consumes the verified bytes.

Root-side trust is exact rather than permissive: `ADMIN_OPS_ROOT_DIR`, `prepared`, `claimed`, `completed`, `work`, and `intervention` must resolve to their literal absolute path, have UID 0, and have mode `0700`; prepared challenge directories use `0500`, prepared files use `0400`, and completed/intervention files use `0400`. Existing insecure directories are rejected, never silently chmod-repaired. Web-facing inbox/upload/status directories retain the Task 3 publisher compatibility boundary and are not required to be root-owned.

Terminal replay records are intentionally retained independently of public status and ordinary artifact cleanup. Late-orphan cleanup only acts when this root-owned terminal record exists, so it cannot race a correctly ordered publisher that has written a secret/upload but has not yet atomically published the job JSON.

### Security Considerations and Residual Risks

- The retained intervention snapshot remains encrypted with the deployment backup key, lives below a `0700` per-job directory, and is `0400`. The claimed job record contains identifiers only; secrets, database URLs, plaintext dumps, verification files, and command output are not retained or audited.
- Rollback quiescing is fail-closed. If stopping the app or terminating its sessions fails, no rollback `pg_restore` command is invoked and maintenance remains active for manual recovery.
- Root ownership checks are exercised through a controlled `stat` test double because the test runner is intentionally unprivileged; production executes the same checks against the host `stat` implementation.
- Hard-link pinning assumes prepared and work directories reside on the same filesystem beneath `ADMIN_OPS_ROOT_DIR`, which is part of the configured layout. A cross-filesystem customization would fail closed at the link step.
- Completed UUID records intentionally accumulate to preserve replay protection. Rotation or archival policy is operational follow-up work and must preserve the no-reuse invariant.
- Intervention recovery remains manual by design. This task preserves the verified encrypted snapshot and evidence but does not implement an operator-facing recovery command.

## Fix Round 2

### Summary

Addressed both findings from the re-review of `283f547..1d957ee`:

1. A completed-ledger publication failure now converts every otherwise-terminal job into `intervention-required`. For a successful destructive restore, the worker reasserts authoritative maintenance, replaces the public success status with `TERMINAL_STATE_WRITE_FAILED`, retains the verified encrypted rollback snapshot plus the strict identifier-only claimed job, removes all plaintext/prepared/work data, exits non-zero, and blocks reboot admission. Intervention job records also independently reject UUID replay if an operator later clears maintenance.
2. The authoritative marker moved to root-only `${ADMIN_OPS_ROOT_DIR}/maintenance.json` with mode `0600`. `${ADMIN_OPS_DIR}/status/maintenance.json` remains the fixed Task 3 UI/API mirror at mode `0640`, but admission and reboot recovery never consult it. Each worker run re-synchronizes an existing root marker to the mirror before its admission checks.

Cleanup was reassessed across terminal-ledger failures. Inspection failure now destroys the prepared plaintext, upload, passphrase, and working directory while retaining only the identifier-only job record. Restore failure retains only the encrypted rollback snapshot and identifier-only job. Backup secrets continue to be unlinked by the exit cleanup.

### Files Changed

- `ops/lib/maintenance-jobs.sh`
  - Split authoritative marker publication from public mirror publication.
  - Added exact shared marker schema validation and fail-closed root marker reads.
  - Added root-to-public mirror synchronization without any public-to-root data flow.
  - Converted terminal-ledger failures to durable intervention state and generalized intervention retention without retaining secrets or plaintext.
  - Extended replay rejection to root-only intervention job records.
- `ops/maintenance-worker.sh`
  - Synchronizes the mirror from root state and distinguishes authoritative active, inactive/absent, and invalid states before admission.
- `src/server/ops/maintenance-worker.test.ts`
  - Added completed-ledger rename fault injection after successful restore, cleanup fault injection after inspection, active-root/public-delete/public-forge reboot coverage, and inactive-root/public-forge admission coverage.
  - Set the shell integration file to a 15-second per-test budget after full-suite process contention measured two valid cases at 5.014s and 5.375s; no behavioral assertion was changed.
- `.superpowers/sdd/2026-09-03-admin-backup-recovery/task-2-report.md`
  - Recorded Round 2 evidence and invariants.

### TDD RED/GREEN Evidence

Initial focused regressions were added before production changes:

```text
pnpm test src/server/ops/maintenance-worker.test.ts \
  -t 'completed ledger|root-owned active|root-owned inactive|interrupted in-maintenance'
Test Files  1 failed (1)
Tests       4 failed | 24 skipped (28)
```

The completed-ledger fault left the public status at `succeeded`; both worker-published root marker checks failed with `ENOENT`; and reboot recovery trusted the forged public inactive marker and reported `STALE_JOB`. After implementation, the identical command was GREEN:

```text
Test Files  1 passed (1)
Tests       4 passed | 24 skipped (28)
```

The cleanup reassessment added a separate inspection-ledger regression. RED showed that `prepared/{jobId}` still existed:

```text
pnpm test src/server/ops/maintenance-worker.test.ts \
  -t 'completed ledger cannot publish after inspection'
Test Files  1 failed (1)
Tests       1 failed | 28 skipped (29)
```

After forcing prepared cleanup on terminal-ledger failure, the identical command was GREEN:

```text
Test Files  1 passed (1)
Tests       1 passed | 28 skipped (29)
```

### Final Verification

```text
pnpm test src/server/ops/maintenance-worker.test.ts
Test Files  1 passed (1)
Tests       29 passed (29)

pnpm test src/server/ops/portable-backup.test.ts src/server/ops/maintenance-worker.test.ts
Test Files  2 passed (2)
Tests       44 passed (44)

pnpm test
Test Files  65 passed | 2 skipped (67)
Tests       597 passed | 3 skipped (600)

pnpm typecheck  # exit 0
pnpm lint       # exit 0
sh -n ops/lib/maintenance-jobs.sh ops/maintenance-worker.sh  # exit 0
git diff --check  # exit 0
```

The first full-suite attempt produced `595 passed`, `3 skipped`, and two Task 2 timeouts at 5.014s and 5.375s while the same cases passed in focused runs. The test file now uses the same 15-second integration budget already used by its serialization test. The unchanged cases then passed together in `7.83s`, and the full rerun above was green.

### Authority and Publication Invariants

- Authoritative path: `${ADMIN_OPS_ROOT_DIR}/maintenance.json`, atomic rename, UID 0, mode `0600`, exact schema `{schemaVersion:1, active:boolean, jobId?:UUID, updatedAt:string}`. `jobId` is required only when active.
- Public mirror path: `${ADMIN_OPS_DIR}/status/maintenance.json`, atomic rename, mode `0640`, same exact schema. It is mounted/readable for Task 3 UI/API use but has no authority over host execution.
- Data flow is one-way: root marker to public mirror. Deleting the mirror or forging it inactive cannot clear root maintenance; forging it active cannot block jobs when root explicitly records inactive maintenance.
- Missing root marker means no restore has established maintenance state yet. An existing malformed, symlinked, non-root-owned, or incorrectly permissioned root marker is neither active nor inactive: it is invalid, and the worker preserves claimed state and exits non-zero.
- A terminal result is not safely complete until its root-owned completed UUID record exists. Publication failure re-enters maintenance/intervention and preserves a root-only intervention job record, which also supplies replay protection independently of the completed ledger.

### Security Considerations and Residual Risks

- The ledger-failure regression verifies the final status is intervention—not success—and that reboot performs no further database/application commands.
- The retained restore intervention directory contains exactly `job.json` (`0400`) and the verified encrypted `rollback.dump.enc` (`0400`) beneath a `0700` directory. Prepared dump, linked claim, plaintext rollback dump, verification dump, upload, and passwords are absent.
- The retained inspection intervention directory contains only `job.json`; its decrypted prepared data, upload, secret, and work directory are removed.
- The public mirror remains writable by its deployment owner and therefore may temporarily lie between worker invocations. This is acceptable only because it is explicitly informational; the root worker refreshes it before admission and never branches on its contents.
- Root marker loss by a root-capable actor is outside the UID-1001 threat boundary. Invalid existing root state fails closed, while an absent marker preserves first-install compatibility.
