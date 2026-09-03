# Task 3 Report — Installer, Compose, nginx, systemd, and off-host scheduling

## Status

Implemented on base `231fbee613643ab783ce28062085b0a8eb843e66`.

## Implementation

- Added the two minimal application bind mounts: the UID/GID-1001 web spool is writable and the root-owned portable backup directory is read-only. The app receives fixed container paths and the byte limit, but no Docker socket, host environment/key files, migration URL, or root maintenance tree.
- Resolved the producer/consumer permission boundary discovered during integration: completed portable archives are published only after ciphertext validation as `root:${PORTABLE_BACKUP_READER_GID}` mode `0640` (production default GID `1001`). The app receives that numeric reader group as a supplemental group while its backup mount remains read-only. Ownership or mode failures abort publication, clean the new partial/archive, and leave history and `ready` status unpublished.
- Added validated, upgrade-preserving host environment defaults for the web spool, root-only state, portable backups/history, and the 512 MiB upload ceiling. Overlapping mount/state roots are replaced with isolated defaults and rejected by runtime configuration validation.
- Installed `age`, `jq`, and `util-linux` idempotently with the existing host dependency workflow.
- Added idempotent host installation for the exact web/root/portable ownership boundaries, maintenance path/service, off-host backup service/timer, and a mode-`0600` logrotate definition retaining 180 daily rotations. Upgrades normalize only regular, timestamp-matching `.fitgridbackup` files to `root:<reader>`/`0640`, skip symlinks and unrelated files, and preserve history, prepared restore data, authoritative marker state, backup payloads, and secrets.
- Added a path-activated root maintenance service using the fixed installed worker, Docker ordering, `UMask=0077`, and a GID compatible with app-readable public status files. The authoritative marker remains under the unmounted root tree; the app sees only the public status mirror.
- Added conservative unattended-backup activation: the timer is enabled only for a non-root, canonical, existing, writable directory whose `findmnt` device differs from `/`; otherwise any existing timer is disabled and the required Chinese guidance is printed.
- Raised both managed `/fitgrid` location upload ceilings from 10 MiB to the validated byte limit rounded up to MiB and increased read/send timeouts to 600 seconds. Existing vhost contents, listeners, and unrelated nginx/sing-box configuration remain untouched.
- Installed maintenance components only after the app boot unit and public endpoint are healthy. A maintenance-component failure reports its exact component and returns failure without rolling back or stopping the healthy application.

## TDD evidence

Initial RED command, before production changes:

```text
pnpm test src/server/ops/install-host.test.ts src/server/ops/install-nginx.test.ts \
  src/server/ops/install-deploy.test.ts src/server/ops/low-memory-compose.test.ts \
  src/server/ops/config.test.ts src/server/ops/install-common.test.ts
```

The first run exposed one test-fixture interpolation parse error plus eight intended behavior failures: missing Compose mounts, unrecognized maintenance environment fields, absent generated defaults, the old 10 MiB/60-second nginx behavior, absent post-health maintenance installation, and absent failure-retention behavior. The fixture interpolation was corrected without touching production code; the host-only rerun then produced five intended failures (missing `age`/`jq`/`util-linux` installation and missing maintenance installer/templates).

Two later security refinements each followed their own RED/GREEN cycle:

```text
pnpm test src/server/ops/install-host.test.ts -t overlaps
Tests: 1 failed | 8 skipped

pnpm test src/server/ops/config.test.ts -t 'root tree exposed'
Tests: 1 failed | 22 skipped

pnpm test src/server/ops/install-common.test.ts -t 'overlapping maintenance roots'
Tests: 1 failed | 12 skipped
```

Those failures proved an app-writable/read-only mount could overlap root-only state. After adding installer, environment-generation, and TypeScript validation, the combined targeted rerun passed 3/3.

The integration-discovered portable archive handoff used additional RED/GREEN cycles. The Task 1 success assertion was intentionally changed from `0600` to `0640`: `0600` made the read-only archive mount unusable to the UID/GID-1001 download process, while `root:1001` ownership plus `0640` permits reads without granting mutation.

```text
pnpm test src/server/ops/portable-backup.test.ts \
  -t 'publishes one inspected|reader ownership|non-numeric portable'
Tests: 3 failed | 14 skipped

pnpm test src/server/ops/install-host.test.ts -t 'normalizes only regular'
Tests: 1 failed | 9 skipped

pnpm test src/server/ops/config.test.ts src/server/ops/install-common.test.ts
Tests: 3 failed | 35 passed

pnpm test src/server/ops/low-memory-compose.test.ts -t 'mounts only'
Tests: 1 failed | 3 skipped

pnpm test src/server/ops/config.test.ts -t exponential
Tests: 1 failed | 25 skipped
```

The resulting focused GREEN covered `0640` publication, validation-before-handoff ordering, strict numeric/non-root GID validation, ownership and mode failure cleanup with no history publication, supplemental container reader group, and symlink-safe upgrade normalization:

```text
pnpm test src/server/ops/portable-backup.test.ts \
  -t 'publishes one inspected|reader ownership|reader mode|non-numeric portable'
Tests: 4 passed | 14 skipped

pnpm test src/server/ops/install-host.test.ts src/server/ops/config.test.ts \
  src/server/ops/install-common.test.ts
Tests: 48 passed
```

Original Task 3 focused GREEN (before the integration expansion):

```text
pnpm test src/server/ops/install-host.test.ts src/server/ops/install-nginx.test.ts \
  src/server/ops/install-deploy.test.ts src/server/ops/low-memory-compose.test.ts \
  src/server/ops/config.test.ts src/server/ops/install-common.test.ts
Test Files  6 passed (6)
Tests       74 passed (74)
```

## Verification

```text
pnpm test src/server/ops
Test Files  10 passed (10)
Tests       134 passed (134)

pnpm test src/server/ops/portable-backup.test.ts src/server/ops/maintenance-jobs.test.ts \
  src/server/ops/maintenance-worker.test.ts src/server/ops/install-host.test.ts \
  src/server/ops/install-nginx.test.ts src/server/ops/install-deploy.test.ts \
  src/server/ops/low-memory-compose.test.ts src/server/ops/config.test.ts \
  src/server/ops/install-common.test.ts
Test Files  8 passed (8)
Tests       125 passed (125)

pnpm test
Test Files  65 passed | 2 skipped (67)
Tests       618 passed | 3 skipped (621)

pnpm typecheck  # exit 0
pnpm lint       # exit 0
sh -n ops/install-production.sh ops/lib/install-common.sh ops/lib/install-host.sh \
  ops/lib/install-nginx.sh ops/lib/install-deploy.sh ops/lib/portable-backup.sh \
  ops/lib/maintenance-jobs.sh ops/maintenance-worker.sh ops/backup.sh \
  ops/backup-portable.sh  # exit 0
git diff --check  # exit 0
```

The restricted operations-suite run failed only the two pre-existing pseudo-TTY tests with `stty: TIOCGETD: Operation not permitted`; the approved local-permission reruns above passed the Task 1–3 set 125/125, operations 134/134, and full suite 618/621 with three expected skips.

## Residual risks

- Native `docker compose config` and systemd unit verification could not run because this macOS workspace has neither Docker nor systemd tooling. YAML structure, unit content, shell orchestration, permission handoff, and installation side effects are covered by automated tests; Ubuntu production-equivalent validation remains Task 7.
