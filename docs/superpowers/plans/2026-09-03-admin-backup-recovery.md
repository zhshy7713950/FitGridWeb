# Administrator Backup and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add administrator-controlled portable database backups, five-item download history, safe upload/inspection/whole-database recovery, and an interactive one-command VPS backup script.

**Architecture:** The Next.js application authenticates administrators, streams uploads, and exchanges fixed-schema files with a host spool. A systemd path-activated worker owns PostgreSQL tooling, age encryption, Docker lifecycle, rollback, retention, and root-only audit; the public application never receives Docker access or migration credentials. Portable `.fitgridbackup` archives use an independent passphrase, while existing server-key backups remain the unattended off-host path.

**Tech Stack:** Next.js 16 Route Handlers, React 19, TypeScript 5.9, Better Auth 1.7, shell scripts, Docker Compose, PostgreSQL 17 custom dumps, age passphrase encryption, systemd, nginx, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-03-admin-backup-recovery-design.md`

> **Security amendment (2026-09-04):** The original Task 1 pseudocode below records the initial TDD plan and is superseded for portable uploads by format v3. Current portable archives contain only seven fixed canonical CSV members plus exact manifest/checksums; each CSV row is Base64 UTF-8 JSON. Creation uses static `COPY TO STDOUT`, and recovery rebuilds the reviewed schema with migrations before a single static `COPY FROM STDIN`/`INSERT` transaction. Uploaded material is never passed to `pg_restore`; v1 and v2 archives are rejected. Internal server-key rollback snapshots remain trusted custom dumps.

## Global Constraints

- Only an active administrator may create, list, download, inspect, or confirm complete backups.
- The browser workflow never exposes a standalone clear operation; production replacement requires a successfully inspected `.fitgridbackup`.
- Current administrator passwords and backup passphrases are never persisted in browser storage, the database, ordinary logs, audit records, command arguments, or final job status.
- Portable backup passwords contain 12–128 characters and are confirmed before backup creation.
- Completed portable backup history contains at most five entries; pruning happens only after a new archive passes every validation.
- Uploads default to at most 512 MiB and are streamed to disk rather than buffered in JavaScript memory.
- The application container never receives the Docker socket, `/etc/fitgridweb/fitgridweb.env`, `/etc/fitgridweb/backup.key`, or the database migration URL.
- A restore creates and verifies a rollback snapshot before stopping writes, clears all restored Better Auth sessions, and leaves maintenance mode active if both restore and rollback fail.
- All files and status transitions use fixed directories, validated identifiers, fixed operation allowlists, private permissions, and atomic rename.
- Existing nginx/sing-box listeners and locations remain unchanged except for the managed `/fitgrid` upload limit and proxy timeouts.
- UI follows the existing TradingView-derived dark financial language, keeps keyboard/focus/mobile behavior, and never polls faster than once per second.
- Tests are written and observed failing before each production change.

---

### Task 1: Portable archive library and one-command backup

**Files:**
- Create: `ops/lib/portable-backup.sh`
- Create: `ops/backup-portable.sh`
- Create: `src/server/ops/portable-backup.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `fitgrid_compose`, `POSTGRES_DB`, `POSTGRES_USER`, `APP_IMAGE`, and the host `age`, `tar`, `sha256sum`, `mktemp`, and Docker Compose commands.
- Produces: `create_portable_backup PASSPHRASE_FILE OUTPUT_DIRECTORY HISTORY_FILE [STATUS_FILE]`, `inspect_portable_backup ARCHIVE PASSPHRASE_FILE PREPARED_DIRECTORY RESULT_FILE`, `prune_portable_backups OUTPUT_DIRECTORY HISTORY_FILE 5`, and the interactive command `ops/backup-portable.sh`.
- Archive: age-passphrase ciphertext containing exactly the seven fixed application-table CSV files, `manifest.json`, and `payload.sha256` defined by format v3.

- [ ] **Step 1: Write failing shell behavior tests**

Add tests that run the real scripts with fake external executables. Derive all expectations from literal fixtures, not the shell implementation:

```ts
it("publishes one inspected age archive and only then prunes the sixth backup", async () => {
  const files = await portableFixture({ existingBackups: 5 });
  const result = runPortableCreate(files, "correct horse battery");
  expect(result.status, result.stderr).toBe(0);
  expect(await successfulPortableNames(files.backups)).toEqual([
    "fitgridweb-20260903T070000Z.fitgridbackup",
    "fitgridweb-20260902T070000Z.fitgridbackup",
    "fitgridweb-20260901T070000Z.fitgridbackup",
    "fitgridweb-20260831T070000Z.fitgridbackup",
    "fitgridweb-20260830T070000Z.fitgridbackup",
  ]);
  expect(await readJson(files.history)).toMatchObject({ entries: [{ size: 321 }] });
});

it("keeps all five old backups when encryption fails", async () => {
  const files = await portableFixture({ existingBackups: 5, ageExit: 9 });
  expect(runPortableCreate(files, "correct horse battery").status).toBe(9);
  expect(await successfulPortableNames(files.backups)).toHaveLength(5);
  expect(await recursiveNames(files.backups)).not.toContainEqual(expect.stringMatching(/\.partial/));
});

it.each(["wrong password", "tampered archive", "../escape", "unknown format"])(
  "rejects %s before publishing a prepared dump",
  async (caseName) => {
    const files = await portableInspectFixture(caseName);
    expect(runPortableInspect(files).status).not.toBe(0);
    expect(await recursiveNames(files.prepared)).toEqual([]);
  },
);
```

For the CLI, attach a pseudo-TTY and assert that two matching 12-character-or-longer passwords create an archive while mismatched and short values reprompt. Assert the process command log never contains the supplied password.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm test src/server/ops/portable-backup.test.ts
```

Expected: FAIL because `ops/lib/portable-backup.sh` and `ops/backup-portable.sh` do not exist.

- [ ] **Step 3: Implement the portable archive functions**

Build archives in a private temporary directory, validate the custom dump before encryption, and publish with atomic rename. Use fixed archive member names and an independently derived literal manifest:

```sh
create_portable_backup() {
  passphrase_file=$1
  output_directory=$2
  history_file=$3
  status_file=${4:-}
  require_private_file "$passphrase_file" "Portable backup passphrase"
  portable_require_passphrase "$passphrase_file"
  portable_require_space "$output_directory"

  timestamp=${FITGRID_BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
  base="fitgridweb-$timestamp"
  work=$(mktemp -d "$output_directory/.${base}.XXXXXX")
  trap 'portable_cleanup "$work"' EXIT HUP INT TERM
  portable_status "$status_file" dumping
  fitgrid_compose exec -T db pg_dump --format=custom --data-only --no-owner --no-privileges \
    --exclude-table-data=public._prisma_migrations \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" >"$work/database.dump"
  portable_validate_data_only_dump "$work/database.dump" "$work"
  (cd "$work" && sha256sum database.dump >database.dump.sha256)
  portable_write_manifest "$work/manifest.json" "$timestamp"
  portable_status "$status_file" encrypting
  portable_age_encrypt "$passphrase_file" "$work" "$output_directory/$base.fitgridbackup.partial"
  portable_validate_ciphertext "$output_directory/$base.fitgridbackup.partial" "$passphrase_file"
  portable_durable_replace "$output_directory/$base.fitgridbackup.partial" "$output_directory/$base.fitgridbackup"
  portable_record_success "$history_file" "$base" "$timestamp"
  prune_portable_backups "$output_directory" "$history_file" 5
  portable_status "$status_file" ready
}
```

Use the verified official `age-plugin-batchpass` with exact `age -e -j batchpass` / `age -d -j batchpass` calls. Pass the secret only through the descriptor named by `AGE_PASSPHRASE_FD`; never place it in argv, `AGE_PASSPHRASE`, or logs. The security amendment above supersedes the custom-dump pseudocode: `inspect_portable_backup` rejects non-regular members, links, traversal, duplicates/extras, expansion beyond the cap, non-exact checksums/manifest/counts, legacy/unknown versions, incompatible PostgreSQL majors, and non-canonical row framing before publishing `PREPARED_DIRECTORY/payload.tar` with mode `0600`.

- [ ] **Step 4: Implement the TTY-only wrapper**

`backup-portable.sh` must require root and a TTY, read both passwords with echo disabled, restore terminal state on every exit, and call the shared function:

```sh
[ -t 0 ] || { echo "便携备份必须在交互式终端运行" >&2; exit 1; }
while :; do
  portable_read_secret "独立备份密码（12–128 个字符）" first
  portable_read_secret "再次输入独立备份密码" second
  portable_validate_secret_values "$first" "$second" && break
done
passphrase_file=$(portable_secret_file "$first")
unset first second
create_portable_backup "$passphrase_file" "$PORTABLE_BACKUP_DIR" "$PORTABLE_BACKUP_HISTORY_FILE"
```

Add `PORTABLE_BACKUP_DIR`, `PORTABLE_BACKUP_HISTORY_FILE`, `ADMIN_OPS_DIR`, and `PORTABLE_BACKUP_MAX_BYTES=536870912` examples without real secrets.

- [ ] **Step 5: Run focused and existing operations tests**

Run:

```bash
pnpm test src/server/ops/portable-backup.test.ts src/server/ops/scripts.test.ts
```

Expected: PASS with no password in captured stdout, stderr, or command logs.

- [ ] **Step 6: Commit**

```bash
git add ops/lib/portable-backup.sh ops/backup-portable.sh .env.example src/server/ops/portable-backup.test.ts
git commit -m "feat: add portable database backups"
```

---

### Task 2: Host maintenance job state machine and rollback

**Files:**
- Create: `ops/lib/maintenance-jobs.sh`
- Create: `ops/maintenance-worker.sh`
- Create: `src/server/ops/maintenance-worker.test.ts`

**Interfaces:**
- Consumes: Task JSON and secret files beneath `${ADMIN_OPS_DIR}/inbox`, the portable archive functions from Task 1, fixed Compose configuration, and `/etc/fitgridweb/backup.key` for rollback snapshots only.
- Produces: Atomic `${ADMIN_OPS_DIR}/status/{jobId}.json`, prepared restores beneath root-only `${ADMIN_OPS_ROOT_DIR}/prepared/{jobId}`, root-only JSONL audit, and fixed job handlers for `backup`, `inspect-restore`, and `restore`.
- Job states: `queued | dumping | encrypting | ready | uploading | inspecting | awaiting-confirmation | snapshotting | restoring | migrating | checking | succeeded | failed | rollback | intervention-required`.

- [ ] **Step 1: Write failing state-machine tests**

Use real worker scripts with fake `docker`, `curl`, `age`, and portable archives. Assert externally visible sequencing:

```ts
it("serializes jobs and reports backup stages atomically", async () => {
  const files = await workerFixture();
  await files.enqueue({ schemaVersion: 1, id: JOB_A, type: "backup", actorId: ADMIN });
  await files.enqueue({ schemaVersion: 1, id: JOB_B, type: "backup", actorId: ADMIN });
  const result = files.runWorker();
  expect(result.status).toBe(0);
  expect(await files.transitions(JOB_A)).toEqual(["queued", "dumping", "encrypting", "ready"]);
  expect(await files.transitions(JOB_B)).toEqual(["queued", "dumping", "encrypting", "ready"]);
  expect(await files.maxConcurrentCommands()).toBe(1);
});

it("rolls production back exactly once when restored application health fails", async () => {
  const files = await workerFixture({ restoredHealth: false, rollbackHealth: true });
  await files.enqueueRestore(RESTORE_JOB);
  expect(files.runWorker().status).toBe(0);
  expect(await files.commandSequence()).toEqual([
    "rollback-snapshot", "stop-app", "terminate-app-connections", "restore-upload",
    "migrate", "delete-sessions", "start-app", "health-failed", "restore-rollback",
    "migrate", "start-app", "health-ok",
  ]);
  expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "failed", rolledBack: true });
});

it("leaves maintenance active when restore and rollback both fail", async () => {
  const files = await workerFixture({ restoredHealth: false, rollbackHealth: false });
  await files.enqueueRestore(RESTORE_JOB);
  expect(files.runWorker().status).not.toBe(0);
  expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "intervention-required" });
  expect(await files.maintenance()).toMatchObject({ active: true });
});
```

Also cover invalid JSON, unknown operations, non-UUID IDs, user-controlled paths, replaced prepared dump, expired challenges, stale pre-maintenance jobs after reboot, secret cleanup, and audit redaction.

- [ ] **Step 2: Run the worker test and verify RED**

Run:

```bash
pnpm test src/server/ops/maintenance-worker.test.ts
```

Expected: FAIL because the worker and job library do not exist.

- [ ] **Step 3: Implement strict job parsing, locks, status, and audit**

Use a non-blocking host lock and reject fields outside the operation schema. Never evaluate JSON as shell:

```sh
exec 9>"$ADMIN_OPS_ROOT_DIR/maintenance.lock"
flock -n 9 || exit 0

job_type=$(jq -er '.type | select(. == "backup" or . == "inspect-restore" or . == "restore")' "$job_file")
job_id=$(jq -er '.id | select(test("^[0-9a-f-]{36}$"))' "$job_file")
actor_id=$(jq -er '.actorId | select(test("^[0-9a-f-]{36}$"))' "$job_file")
portable_assert_job_paths "$job_id"
```

Write every status to a temporary file, `chmod 0640`, then rename. Audit only stable codes and hashes. Move claimed jobs out of `inbox` before execution so one job cannot run twice.

- [ ] **Step 4: Implement inspection expiry and production restore**

Inspection publishes a root-only prepared dump plus immutable manifest/status metadata and schedules expiry based on a UTC epoch. Restore must use only that prepared artifact:

```sh
maintenance_snapshot_before_restore "$job_id"
maintenance_set_active "$job_id"
fitgrid_compose stop app
maintenance_terminate_runtime_connections
maintenance_restore_dump "$prepared_dump"
maintenance_run_migrations
maintenance_delete_all_sessions
fitgrid_compose up --no-build -d --wait app
maintenance_verify_health
maintenance_clear_active
```

Wrap the sequence with one rollback attempt using the server-key snapshot. A failed rollback writes `intervention-required`, keeps the maintenance marker, and exits non-zero. All success/failure paths remove passphrase files, uploads, prepared plaintext, and working directories.

- [ ] **Step 5: Run worker and archive tests**

Run:

```bash
pnpm test src/server/ops/maintenance-worker.test.ts src/server/ops/portable-backup.test.ts
```

Expected: PASS; the command log confirms application stop occurs only after a rollback snapshot and a valid prepared dump.

- [ ] **Step 6: Commit**

```bash
git add ops/lib/maintenance-jobs.sh ops/maintenance-worker.sh src/server/ops/maintenance-worker.test.ts
git commit -m "feat: add safe maintenance worker"
```

---

### Task 3: Installer, Compose, nginx, systemd, and scheduled off-host backup

**Files:**
- Create: `ops/templates/fitgridweb-maintenance.path`
- Create: `ops/templates/fitgridweb-maintenance.service`
- Create: `ops/templates/fitgridweb-backup.service`
- Create: `ops/templates/fitgridweb-backup.timer`
- Create: `ops/templates/fitgridweb-ops.logrotate`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.low-memory.yml`
- Modify: `ops/lib/install-common.sh`
- Modify: `ops/lib/install-host.sh`
- Modify: `ops/lib/install-nginx.sh`
- Modify: `ops/lib/install-deploy.sh`
- Modify: `ops/install-production.sh`
- Modify: `src/server/ops/install-host.test.ts`
- Modify: `src/server/ops/install-nginx.test.ts`
- Modify: `src/server/ops/install-deploy.test.ts`
- Modify: `src/server/ops/low-memory-compose.test.ts`
- Modify: `src/server/ops/config.ts`
- Modify: `src/server/ops/config.test.ts`

**Interfaces:**
- Consumes: host directory and size variables from Task 1 and worker entry point from Task 2.
- Produces: idempotent installation of age/jq/flock support, private directories, minimal bind mounts, systemd path activation, optional daily off-host timer, upload limit, logrotate, and reboot-safe configuration.

- [ ] **Step 1: Write failing installation and privilege-boundary tests**

Add behavioral assertions:

```ts
it("mounts only the web spool writable and portable backups read-only", async () => {
  const compose = await loadCompose();
  expect(compose.services.app.volumes).toEqual([
    "${ADMIN_OPS_WEB_DIR:?ADMIN_OPS_WEB_DIR is required}:/var/lib/fitgridweb/admin-ops:rw",
    "${PORTABLE_BACKUP_DIR:?PORTABLE_BACKUP_DIR is required}:/var/lib/fitgridweb/portable-backups:ro",
  ]);
  expect(JSON.stringify(compose.services.app)).not.toMatch(/docker\.sock|backup\.key|fitgridweb\.env|MIGRATION_DATABASE_URL/);
});

it("installs and enables the maintenance path without touching sing-box", async () => {
  const files = await fixture();
  expect(runInstallMaintenance(files).status).toBe(0);
  expect(await readFile(files.log, "utf8")).toContain("systemctl enable --now fitgridweb-maintenance.path");
  expect(await readFile(files.log, "utf8")).not.toMatch(/sing-box|10256|30127/);
});

it("does not enable unattended backup without a verified remote mount", async () => {
  const files = await fixture({ backupRemoteDir: "" });
  expect(runInstallBackupTimer(files).status).toBe(0);
  expect(await readFile(files.log, "utf8")).not.toContain("enable --now fitgridweb-backup.timer");
});
```

Extend nginx tests to expect `client_max_body_size 512m`, longer upload/restore proxy timeouts only within both managed `/fitgrid` locations, and unchanged existing vhost/server/listeners.

- [ ] **Step 2: Run installer tests and verify RED**

Run:

```bash
pnpm test src/server/ops/install-host.test.ts src/server/ops/install-nginx.test.ts src/server/ops/install-deploy.test.ts src/server/ops/low-memory-compose.test.ts src/server/ops/config.test.ts
```

Expected: FAIL because maintenance templates, mounts, environment fields, and installation functions are absent.

- [ ] **Step 3: Add environment and Compose boundaries**

`ensure_environment` must preserve valid existing values and create these defaults:

```dotenv
ADMIN_OPS_WEB_DIR=/var/lib/fitgridweb/admin-ops/web
ADMIN_OPS_ROOT_DIR=/var/lib/fitgridweb/admin-ops/root
PORTABLE_BACKUP_DIR=/var/lib/fitgridweb/portable-backups
PORTABLE_BACKUP_HISTORY_FILE=/var/lib/fitgridweb/admin-ops/web/status/backups.json
PORTABLE_BACKUP_MAX_BYTES=536870912
```

Expose only container paths needed by the TypeScript gateway and size limit. Add the two bind mounts asserted by the test. Do not expose migration credentials or server backup key to `app`.

- [ ] **Step 4: Install host dependencies, directories, units, and log rotation**

Install `age`, `jq`, and `util-linux` with existing Docker dependencies. Build directories with explicit numeric ownership for container UID/GID 1001 and root-only worker state:

```sh
install -d -m 0700 -o 1001 -g 1001 "$ADMIN_OPS_WEB_DIR/inbox" "$ADMIN_OPS_WEB_DIR/uploads"
install -d -m 0750 -o 1001 -g 1001 "$ADMIN_OPS_WEB_DIR/status"
install -d -m 0700 -o root -g root "$ADMIN_OPS_ROOT_DIR" "$ADMIN_OPS_ROOT_DIR/prepared"
install -d -m 0750 -o root -g 1001 "$PORTABLE_BACKUP_DIR"
```

The path unit watches the fixed inbox glob and starts a oneshot worker. `fitgridweb-maintenance.service` must require Docker, use the fixed installed script path, apply `UMask=0077`, and remain separate from the boot `fitgridweb.service`. Install logrotate with mode `0600` and 180 daily rotations.

- [ ] **Step 5: Configure optional unattended off-host backups**

Install but do not enable the backup timer unless `BACKUP_REMOTE_DIR` is non-empty, not `/`, resolves to a mounted filesystem distinct from the root backing device, and is writable. The timer uses:

```ini
[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true
RandomizedDelaySec=10m
```

When validation passes, enable with `systemctl enable --now fitgridweb-backup.timer`; otherwise print `自动异机备份未启用：请配置并挂载 BACKUP_REMOTE_DIR`.

- [ ] **Step 6: Update nginx and idempotent upgrade installation**

Render upload limits and timeouts from the validated byte limit converted to MiB. Install or upgrade all units after application health succeeds; on installation failure retain the running app and report the precise maintenance component failure. Re-running `--upgrade` preserves backup files, history, prepared recovery state, environment secrets, and existing off-host configuration.

- [ ] **Step 7: Run the operations suite**

Run:

```bash
pnpm test src/server/ops
```

Expected: PASS; test logs contain no destructive Compose volume deletion and no references to sing-box management.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml docker-compose.low-memory.yml ops src/server/ops
git commit -m "feat: install backup maintenance services"
```

---

### Task 4: Server maintenance gateway, reauthentication, and download tokens

**Files:**
- Create: `src/server/maintenance/types.ts`
- Create: `src/server/maintenance/file-maintenance-gateway.ts`
- Create: `src/server/maintenance/file-maintenance-gateway.test.ts`
- Create: `src/server/maintenance/admin-reauthentication.ts`
- Create: `src/server/maintenance/admin-reauthentication.test.ts`
- Create: `src/server/maintenance/download-token.ts`
- Create: `src/server/maintenance/download-token.test.ts`
- Modify: `src/server/runtime/services.ts`
- Modify: `src/server/security/request-protection.ts`
- Modify: `src/server/security/request-protection.test.ts`

**Interfaces:**
- Consumes: `FitGridAuth.api.verifyPassword`, current `AuthenticatedUser`, fixed container spool paths, request IDs, and the existing same-origin/rate-limit infrastructure.
- Produces: `MaintenanceGateway`, `FileMaintenanceGateway`, `reauthenticateAdmin(auth, headers, password)`, `issueDownloadToken`, and atomic one-time `consumeDownloadToken`.

- [ ] **Step 1: Write failing gateway and authentication tests**

```ts
it("queues a backup without persisting either password in JSON status", async () => {
  const files = await gatewayFixture();
  const job = await files.gateway.createBackup({
    actorId: ADMIN_ID,
    requestId: "01JREQ",
    passphrase: "portable secret phrase",
  });
  expect(await files.job(job.id)).toEqual({
    schemaVersion: 1, id: job.id, type: "backup", actorId: ADMIN_ID, requestId: "01JREQ",
  });
  expect(await files.secretMode(job.id)).toBe(0o600);
  expect(JSON.stringify(await files.allPublicFiles())).not.toContain("portable secret phrase");
});

it("maps Better Auth password failure without creating a new session", async () => {
  const verifyPassword = vi.fn().mockRejectedValue(new APIError("BAD_REQUEST"));
  await expect(reauthenticateAdmin(authWith({ verifyPassword }), headers, "wrong-password"))
    .rejects.toMatchObject({ status: 401, code: "CURRENT_PASSWORD_INVALID" });
  expect(verifyPassword).toHaveBeenCalledWith({ body: { password: "wrong-password" }, headers });
});

it("consumes a download token once and binds it to admin and backup", async () => {
  const service = tokenServiceFixture();
  const token = await service.issue({ adminId: ADMIN_ID, backupId: BACKUP_ID, now: NOW });
  await expect(service.consume(token, ADMIN_ID, BACKUP_ID, NOW)).resolves.toBeUndefined();
  await expect(service.consume(token, ADMIN_ID, BACKUP_ID, NOW)).rejects.toMatchObject({ status: 404 });
});
```

Cover malformed status JSON as a safe 500, path traversal IDs, symlink targets, atomic `O_EXCL` job creation, concurrent active job conflict, status redaction, history filtering/sorting, and token expiry/mismatch.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm test src/server/maintenance
```

Expected: FAIL because maintenance server modules do not exist.

- [ ] **Step 3: Implement types and gateway**

Define discriminated public status and history types:

```ts
export type MaintenanceState =
  | "queued" | "dumping" | "encrypting" | "ready" | "uploading" | "inspecting"
  | "awaiting-confirmation" | "snapshotting" | "restoring" | "migrating"
  | "checking" | "succeeded" | "failed" | "rollback" | "intervention-required";

export type PortableBackupSummary = {
  id: string;
  createdAt: string;
  size: number;
  sha256: string;
};
```

Validate every disk read with zod, derive every path from a validated UUID/backup ID, use `open(..., "wx", 0o600)` for secret and upload creation, and publish tasks/status with atomic rename. Do not use module-level mutable request state.

- [ ] **Step 4: Implement Better Auth reauthentication and persistent one-time tokens**

Call Better Auth's session-bound `verifyPassword` endpoint, classify only public errors, and never call sign-in. Token payload includes admin ID, backup ID, nonce and 60-second expiry, signed with `BETTER_AUTH_SECRET`; consume by atomically creating a digest marker with `wx` so restart and parallel processes cannot replay it.

- [ ] **Step 5: Add maintenance-specific throttles and runtime wiring**

Add independent limiters for backup creation, upload inspection, restore confirmation, status reads, and token issue. `getRuntimeServices()` instantiates `FileMaintenanceGateway` from fixed container environment paths and a token service from existing secrets. Fail closed when production paths or secrets are missing.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm test src/server/maintenance src/server/security/request-protection.test.ts
```

Expected: PASS with no password or host path in serialized public errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/maintenance src/server/runtime/services.ts src/server/security/request-protection.ts src/server/security/request-protection.test.ts
git commit -m "feat: add maintenance job gateway"
```

---

### Task 5: Administrator backup and restore HTTP API

**Files:**
- Create: `src/app/api/v1/admin/backups/route.ts`
- Create: `src/app/api/v1/admin/backups/route.test.ts`
- Create: `src/app/api/v1/admin/backups/[backupId]/download-token/route.ts`
- Create: `src/app/api/v1/admin/backups/[backupId]/download/route.ts`
- Create: `src/app/api/v1/admin/backups/download.test.ts`
- Create: `src/app/api/v1/admin/restores/uploads/route.ts`
- Create: `src/app/api/v1/admin/restores/uploads/route.test.ts`
- Create: `src/app/api/v1/admin/restores/[restoreId]/confirm/route.ts`
- Create: `src/app/api/v1/admin/restores/[restoreId]/confirm/route.test.ts`
- Create: `src/app/api/v1/admin/maintenance/jobs/[jobId]/route.ts`
- Modify: `src/server/http/api-contract.test.ts`
- Modify: `docs/fit-replication/contracts/openapi.yaml`

**Interfaces:**
- Consumes: Task 4 gateway, reauthentication, download token service, `requireAdmin`, same-origin enforcement, rate limits, and web streams.
- Produces: the seven administrator API operations in the approved design and OpenAPI coverage for every handler.
- Upload wire format: `POST .../restores/uploads?fileName=<encoded>` with `Content-Type: application/vnd.fitgrid.backup`, `X-FitGrid-Backup-Passphrase`, `X-FitGrid-Backup-Size`, and the raw archive body. nginx and the counted stream enforce the actual byte limit even if the declared size is false.

- [ ] **Step 1: Write failing authorization and backup route tests**

```ts
it.each(["anonymous", "member", "disabled-admin"])("rejects %s before touching the spool", async (role) => {
  const services = routeFixture({ role });
  const response = await POST(backupRequest());
  expect(response.status).toBe(role === "member" ? 403 : 401);
  expect(services.maintenance.createBackup).not.toHaveBeenCalled();
});

it("reauthenticates and queues one matching 12-character backup password", async () => {
  const response = await POST(backupRequest({
    currentPassword: "current-password",
    backupPassword: "portable-password",
    confirmBackupPassword: "portable-password",
  }));
  expect(response.status).toBe(202);
  await expect(response.json()).resolves.toMatchObject({ state: "queued" });
});
```

Assert mismatch/length validation, `409 MAINTENANCE_BUSY`, `429`, public request IDs, five-entry ordering, and absence of passwords in responses.

- [ ] **Step 2: Write failing streaming upload/download and restore tests**

Create a counting `ReadableStream` and prove chunks are handed to the gateway without invoking `request.formData()` or `arrayBuffer()`:

```ts
it("streams an allowed archive and queues inspection", async () => {
  const body = chunkedBody([new Uint8Array(64), new Uint8Array(64)]);
  const response = await uploadRoute.POST(uploadRequest(body, 128));
  expect(response.status).toBe(202);
  expect(gateway.writeUpload).toHaveBeenCalledWith(expect.objectContaining({ size: 128 }), body);
});

it("rejects an oversized declared size before reading the body", async () => {
  const body = observableBody();
  const response = await uploadRoute.POST(uploadRequest(body, 536_870_913));
  expect(response.status).toBe(413);
  expect(body.pullCount()).toBe(0);
});

it("requires password and exact phrase for a bound unexpired restore", async () => {
  const response = await confirmRoute.POST(confirmRequest({ phrase: "恢复全部数据" }), params(RESTORE_ID));
  expect(response.status).toBe(202);
  expect(gateway.confirmRestore).toHaveBeenCalledWith(expect.objectContaining({ actorId: ADMIN_ID }));
});
```

Cover stream interruption cleanup, missing/invalid declared size, understated size, wrong media type/extension, single-use download, range requests disabled, challenge expiry/mismatch, and safe 503 behavior while maintenance is active.

- [ ] **Step 3: Run route tests and verify RED**

Run:

```bash
pnpm test src/app/api/v1/admin/backups src/app/api/v1/admin/restores src/app/api/v1/admin/maintenance
```

Expected: FAIL because route modules do not exist.

- [ ] **Step 4: Implement backup, history, job status, and download routes**

Use strict zod request bodies, `requireAdmin`, reauthentication, operation-specific throttles, and 202 responses. Download creates a Node read stream converted to a web stream and sets:

```ts
return new Response(Readable.toWeb(createReadStream(file.path)) as ReadableStream, {
  headers: {
    "Cache-Control": "no-store, private",
    "Content-Disposition": contentDisposition(file.name),
    "Content-Type": "application/vnd.fitgrid.backup",
    "X-Content-Type-Options": "nosniff",
  },
});
```

Consume the one-time token before opening the file and return 404 for invalid, consumed, expired, mismatched, or missing artifacts.

- [ ] **Step 5: Implement streaming upload and confirmation routes**

Validate cheap headers before reading `request.body`. Pass the web stream directly to `gateway.writeUpload`, which enforces a counted byte ceiling even when `X-FitGrid-Backup-Size` lies. Secret headers must never be echoed. Confirmation accepts only:

```ts
z.strictObject({
  currentPassword: z.string().min(1).max(128),
  confirmationPhrase: z.literal("恢复全部数据"),
})
```

Reauthenticate after resolving an unexpired challenge but before writing the restore job. Return `202` with a job ID; the API does not block for the host restore.

- [ ] **Step 6: Publish the OpenAPI contract and route coverage**

Document request/response schemas, 401/403/409/413/415/422/429/500/503 errors, no-store responses, upload media type, state enum, backup summary, restore preview, and job status. Import every route module into `api-contract.test.ts` so documented and callable operations remain exactly equal.

- [ ] **Step 7: Run API and contract tests**

Run:

```bash
pnpm test src/app/api/v1/admin src/server/http/api-contract.test.ts
```

Expected: PASS; route errors contain public codes and request IDs but no backup password, host path, database URL, or command output.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/v1/admin src/server/http/api-contract.test.ts docs/fit-replication/contracts/openapi.yaml
git commit -m "feat: expose admin backup recovery API"
```

---

### Task 6: TradingView-style data vault UI

**Files:**
- Create: `src/features/admin/data-vault.tsx`
- Create: `src/features/admin/data-vault.test.tsx`
- Create: `src/features/admin/maintenance-api.ts`
- Create: `src/features/admin/maintenance-api.test.ts`
- Create: `src/features/admin/use-maintenance-job.ts`
- Create: `src/features/admin/use-maintenance-job.test.tsx`
- Modify: `src/features/admin/types.ts`
- Modify: `src/features/admin/admin-workspace.tsx`
- Modify: `src/features/admin/admin-workspace.test.tsx`
- Modify: `src/features/admin/admin.module.css`

**Interfaces:**
- Consumes: Task 5 API and the existing modal isolation/focus patterns.
- Produces: `DataVault`, password-confirmed backup creation, three-stage progress, five-item history with download buttons, streamed restore upload/preview/confirmation, maintenance reconnection, and responsive TradingView styling.

- [ ] **Step 1: Write failing client API and polling tests**

```ts
it("sends backup secrets once and never stores them", async () => {
  const storageWrite = vi.spyOn(Storage.prototype, "setItem");
  await createPortableBackup({
    currentPassword: "current-password",
    backupPassword: "portable-password",
    confirmBackupPassword: "portable-password",
  });
  expect(fetch).toHaveBeenCalledWith("/api/v1/admin/backups", expect.objectContaining({ method: "POST" }));
  expect(storageWrite).not.toHaveBeenCalled();
});

it("polls once per second while visible and backs off while hidden", async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockResolvedValue({ state: "dumping" });
  renderHook(() => useMaintenanceJob(JOB_ID, request));
  await vi.advanceTimersByTimeAsync(3_000);
  expect(request).toHaveBeenCalledTimes(4);
  setDocumentVisibility("hidden");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledTimes(5);
});
```

Cover terminal states stopping timers, unmount abort, transient disconnect during restore, reconnection after health returns, Retry-After, and no render-triggered request loop.

- [ ] **Step 2: Write failing backup and restore interaction tests**

```tsx
it("locks duplicate backup submissions and shows the three requested stages", async () => {
  vi.useFakeTimers();
  const getJob = vi.fn()
    .mockResolvedValueOnce({ id: JOB_ID, state: "dumping" })
    .mockResolvedValueOnce({ id: JOB_ID, state: "encrypting" })
    .mockResolvedValueOnce({ id: JOB_ID, state: "ready" });
  render(<DataVault api={api({
    createBackup: vi.fn().mockResolvedValue({ id: JOB_ID, state: "queued" }),
    getJob,
  })} />);
  await userEvent.click(screen.getByRole("button", { name: "创建备份" }));
  await fillBackupDialog();
  const form = screen.getByRole("button", { name: "确认创建" }).closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(apiCreateBackup).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "正在创建备份…" })).toBeDisabled();
  expect(await screen.findByText("正在生成")).toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await screen.findByText("正在加密")).toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await screen.findByText("可以下载")).toBeInTheDocument();
});

it("shows at most five backups with local time, size, and download action", () => {
  render(<DataVault api={api()} initialBackups={sixBackups} />);
  expect(within(screen.getByRole("list", { name: "历史备份" })).getAllByRole("listitem"))
    .toHaveLength(5);
  expect(screen.getAllByRole("button", { name: /下载备份/ })).toHaveLength(5);
  expect(screen.getByText("2026-09-03 15:00")).toBeInTheDocument();
  expect(screen.getByText("12.4 MB")).toBeInTheDocument();
});

it("cannot restore until preview, password recheck, and exact phrase succeed", async () => {
  render(<DataVault api={apiWithRestorePreview()} />);
  await chooseBackupFile("fitgridweb-20260903T070000Z.fitgridbackup");
  await userEvent.type(screen.getByLabelText("备份密码"), "portable-password");
  await userEvent.click(screen.getByRole("button", { name: "上传并检查" }));
  expect(await screen.findByText("24 个网格产品")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "恢复全部数据" })).toBeDisabled();
});
```

Also assert 12–128 validation, password confirmation, cleared inputs on close/success, accessible modal focus trap, error/request ID display, mobile layout, restore maintenance warning, and post-success navigation to `/login`.

- [ ] **Step 3: Run frontend tests and verify RED**

Run:

```bash
pnpm test src/features/admin/data-vault.test.tsx src/features/admin/maintenance-api.test.ts src/features/admin/use-maintenance-job.test.tsx
```

Expected: FAIL because the data-vault modules do not exist.

- [ ] **Step 4: Implement typed client calls and stable polling**

Keep API functions in `maintenance-api.ts`; load heavy restore UI only when opened if splitting provides a meaningful bundle reduction. `useMaintenanceJob` starts polling only from an event-provided job ID, uses one timeout at a time, aborts stale generations, polls at 1 second visible/5 seconds hidden, honors Retry-After, and stops on `ready`, `awaiting-confirmation`, `succeeded`, `failed`, or `intervention-required`.

- [ ] **Step 5: Implement the backup dialog, lifecycle track, and history**

Reuse the existing modal isolation helper. Use controlled password inputs with `autoComplete="current-password"` only for the admin password and `autoComplete="new-password"` for both backup password inputs. Synchronously lock submit via a ref before awaiting. Clear all three fields in `finally` and close paths.

The lifecycle track uses text as the authoritative status and restrained blue/teal state indicators; it must remain readable without color. History uses tabular numerals, exact local timestamp formatting, human-readable IEC size, and a button that first requests a one-time URL then navigates without buffering the backup into browser memory.

- [ ] **Step 6: Implement upload, preview, destructive confirmation, and reconnection**

Upload sends the raw `File.stream()` with declared size and passphrase header. After `awaiting-confirmation`, render the immutable manifest summary. The final dialog requires current password and exact phrase, uses red only for destructive borders/action, and cannot dismiss after confirmation is accepted. During expected app downtime, show “服务器正在恢复数据，请勿关闭页面” and reconnect with the polling hook; on success clear client session state and navigate to the base-path-aware login route.

- [ ] **Step 7: Integrate and style the data vault**

Mount `<DataVault />` between invitation creation and the identity ledger. Extend existing CSS variables rather than introducing a second theme. Desktop uses a two-column backup/recovery control surface; mobile stacks controls, keeps 44px targets, contains filenames, and renders modals as bottom sheets. Respect reduced motion and visible keyboard focus.

- [ ] **Step 8: Run admin UI regression tests**

Run:

```bash
pnpm test src/features/admin
```

Expected: PASS; existing invitation, account pagination, status confirmation, focus isolation, and Retry-After tests remain green.

- [ ] **Step 9: Commit**

```bash
git add src/features/admin
git commit -m "feat: add administrator data vault"
```

---

### Task 7: Operations documentation and production-equivalent verification

**Files:**
- Modify: `README.md`
- Modify: `docs/fit-replication/07-deployment-and-operations.md`
- Modify: `docs/fit-replication/low-memory-vps-runbook.md`
- Modify: `docs/fit-replication/server-implementation-status.md`

**Interfaces:**
- Consumes: every command, state, path, API, and systemd unit delivered by Tasks 1–6.
- Produces: operator procedures for web and CLI backup, download, off-host timer, VPS replacement, recovery failure, quarterly drill, and a verification record that distinguishes automated coverage from environment-gated checks.

- [ ] **Step 1: Write the complete operator procedures**

Document exact commands and expected outcomes for:

```bash
sudo /opt/fitgridweb/ops/backup-portable.sh
systemctl status fitgridweb-maintenance.path --no-pager
systemctl status fitgridweb-backup.timer --no-pager
journalctl -u fitgridweb-maintenance.service --since today --no-pager
journalctl -u fitgridweb-backup.service --since today --no-pager
```

Include: independent password storage, latest-five behavior, browser download, upload preview, restore confirmation, expected logout, automatic rollback, `intervention-required` diagnosis, configuring a true off-host `BACKUP_REMOTE_DIR`, enabling/disabling the timer, checking remote checksums, and quarterly isolated restore evidence.

The VPS replacement procedure must explicitly say: install the same reviewed SHA on the new VPS, create a temporary administrator, upload and inspect the portable backup, restore, log in with an administrator from the backup, migrate `BETTER_AUTH_SECRET`/`OWNER_REF_SECRET`/`CURSOR_SIGNING_SECRET` separately when continuity is required, validate health and grids, then switch DNS while keeping the old VPS read-only for 72 hours.

- [ ] **Step 2: Run all automated verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Expected: every command exits 0 with no unexpected warnings.

- [ ] **Step 3: Run a production-equivalent Docker restore drill**

In an isolated environment with disposable data:

```bash
docker compose --project-name fitgridweb-drill up -d db app
sudo ./ops/backup-portable.sh
```

Create known users and grid products, record counts, create and download a backup, mutate the database, upload/inspect/restore, and verify original counts, RLS account isolation, Android v2.1.0 sample recalculation, cleared sessions, health, and 2 GiB memory behavior. Record actual RPO, RTO, image SHA, PostgreSQL version and result in `server-implementation-status.md`; leave VPS-only gates marked pending if they were not genuinely exercised.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/fit-replication
git commit -m "docs: add backup recovery operations guide"
```

---

### Task 8: Final review and release readiness

**Files:**
- Review: all files changed since `b9d0da9`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: verified branch ready for PR and image build, without deploying or touching production data.

- [ ] **Step 1: Review security mutations**

Mentally and manually mutate each boundary and ensure a test fails for: role changed to member, password verifier bypassed, sixth-file pruning moved before validation, download token reused, declared upload size understated, upload member changed to `../`, restore confirmation altered, rollback snapshot removed, app started before migrations, sessions retained, maintenance marker cleared after double failure, or Docker socket mounted.

- [ ] **Step 2: Review secret and destructive-command exposure**

Run:

```bash
rg -n "backupPassword|passphrase|MIGRATION_DATABASE_URL|docker.sock|pg_restore|volume rm|down -v" src ops docker-compose*.yml
```

Expected: passwords appear only in request/secret-handling code and tests; migration credentials appear only in host-side configuration; there is no Docker socket mount, `volume rm`, `down -v`, or interpolated user-controlled `pg_restore` target.

- [ ] **Step 3: Re-run final verification from a clean build state**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git status --short
```

Expected: tests/typecheck/lint/build exit 0 and status contains only intended tracked changes or is clean after commits.

- [ ] **Step 4: Request code review**

Use `superpowers:requesting-code-review` against the full diff from `b9d0da9`, fix every confirmed issue with a failing regression test first, and repeat the final verification.

- [ ] **Step 5: Prepare integration choice**

Use `superpowers:finishing-a-development-branch` to present merge/PR choices. Do not push, create a PR, build a GitHub image, or deploy to the VPS until the user authorizes that external action.
