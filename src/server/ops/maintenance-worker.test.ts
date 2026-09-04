import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath as fsRealpath,
  readFile,
  readdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FileMaintenanceGateway } from "@/server/maintenance/file-maintenance-gateway";

const projectDirectory = process.cwd();
const worker = path.join(projectDirectory, "ops/maintenance-worker.sh");
const ADMIN = "846b92e7-0f27-4d5e-96e2-429c120e2324";
const JOB_A = "978dbffd-3667-4b37-826b-956f0c63938a";
const JOB_B = "79fc98ea-46a7-40b7-9bb3-e25f2f4ce52d";
const JOB_AFTER_INTERVENTION = "f31b8a91-9f1e-4a55-9f3d-ae4d6c9d9201";
const INSPECT_JOB = "ef4faf98-dc68-409c-b630-5dfbc173c99e";
const RESTORE_JOB = "cba6002b-19c5-4753-a511-ed06c4709036";

const canonicalCsvFiles = [
  "accounts.csv",
  "grid_trades.csv",
  "import_previews.csv",
  "invitations.csv",
  "sessions.csv",
  "users.csv",
  "verifications.csv",
] as const;

function canonicalCsvRow(value: unknown) {
  return `"${Buffer.from(JSON.stringify(value)).toString("base64")}"\n`;
}

function canonicalManifest(appImage = "ghcr.io/example/fitgridweb:sha-2ca7f41") {
  return {
    format: "fitgridweb-portable-backup",
    formatVersion: "3.0.0",
    dumpMode: "canonical-csv",
    dataEncoding: "base64-json-row-v1",
    createdAt: "2026-09-03T07:00:00Z",
    appImage,
    postgresMajor: 17,
    database: "fitgridweb",
    counts: { users: 1, gridTrades: 0, invitations: 0, importPreviews: 0 },
  };
}

async function writeCanonicalPayload(
  directory: string,
  appImage = "ghcr.io/example/fitgridweb:sha-2ca7f41",
  overrides: Partial<Record<(typeof canonicalCsvFiles)[number], string>> = {},
) {
  await mkdir(directory, { recursive: true });
  for (const file of canonicalCsvFiles) {
    await writeFile(path.join(directory, file), overrides[file] ?? "");
  }
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(canonicalManifest(appImage)));
  const checksums = canonicalCsvFiles.map((file) => (
    `${createHash("sha256").update(overrides[file] ?? "").digest("hex")}  ${file}`
  )).join("\n") + "\n";
  await writeFile(path.join(directory, "payload.sha256"), checksums);
}

type WorkerOptions = {
  restoredHealth?: boolean;
  rollbackHealth?: boolean;
  failRollbackQuiesce?: boolean;
};

const testRootUid = typeof process.getuid === "function" ? process.getuid() : 0;
const testRootGid = typeof process.getgid === "function" ? process.getgid() : 0;

async function executable(directory: string, name: string, source: string) {
  const file = path.join(directory, name);
  await writeFile(file, `#!/bin/sh\nset -eu\n${source}\n`);
  await chmod(file, 0o700);
}

async function readJson(file: string) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function waitForFile(file: string, timeoutMilliseconds = 7_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      return await stat(file);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function createPortableArchive(
  root: string,
  appImage = "ghcr.io/example/fitgridweb:sha-2ca7f41",
) {
  const payload = path.join(root, "portable-payload");
  await writeCanonicalPayload(payload, appImage, {
    "users.csv": canonicalCsvRow({
      id: ADMIN,
      name: "管理员, \"测试\"\n第二行",
      email: "admin@example.com",
      email_verified: true,
      image: null,
      username: "admin",
      role: "admin",
      status: "active",
      created_at: "2026-09-03T07:00:00.000Z",
      updated_at: "2026-09-03T07:00:00.000Z",
      literal: "\\.\nDROP TABLE users;",
    }),
  });
  const archive = path.join(root, "upload.fitgridbackup");
  const result = spawnSync(
    "tar",
    ["-cf", archive, ...canonicalCsvFiles, "manifest.json", "payload.sha256"],
    { cwd: payload, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return archive;
}

async function workerFixture(options: WorkerOptions = {}) {
  const root = await mkdtemp(path.join(await fsRealpath(tmpdir()), "fitgrid-maintenance-"));
  const bin = path.join(root, "bin");
  const web = path.join(root, "web");
  const rootOps = path.join(root, "root");
  const inbox = path.join(web, "inbox");
  const uploads = path.join(web, "uploads");
  const statuses = path.join(web, "status");
  const prepared = path.join(rootOps, "prepared");
  const backups = path.join(root, "backups");
  const transitionsDirectory = path.join(root, "transitions");
  const environmentFile = path.join(root, ".env");
  const history = path.join(statuses, "backups.json");
  const commandLog = path.join(root, "commands.log");
  const dockerArgsLog = path.join(root, "docker-args.log");
  const healthUrlLog = path.join(root, "health-urls.log");
  const flockArgsLog = path.join(root, "flock-args.log");
  const audit = path.join(rootOps, "audit.jsonl");
  const sha256Log = path.join(root, "sha256.log");
  const activeCount = path.join(root, "active-count");
  const maxActive = path.join(root, "max-active");
  const backupKey = path.join(root, "backup.key");
  const fence = path.join(root, "run", "maintenance.flag");
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(inbox, { recursive: true }),
    mkdir(uploads, { recursive: true }),
    mkdir(statuses, { recursive: true }),
    mkdir(prepared, { recursive: true }),
    mkdir(backups, { recursive: true }),
    mkdir(transitionsDirectory, { recursive: true }),
  ]);
  await writeFile(history, JSON.stringify({ entries: [] }));
  await writeFile(commandLog, "");
  await writeFile(dockerArgsLog, "");
  await writeFile(healthUrlLog, "");
  await writeFile(flockArgsLog, "");
  await writeFile(sha256Log, "");
  await writeFile(activeCount, "0\n");
  await writeFile(maxActive, "0\n");
  await writeFile(backupKey, "server rollback key material");
  await chmod(backupKey, 0o600);
  await chmod(rootOps, 0o700);
  await chmod(prepared, 0o700);
  await writeFile(
    environmentFile,
    [
      "DOMAIN=grid.example.com",
      "PUBLIC_HTTPS_PORT=443",
      "PUBLIC_PORT_SUFFIX=",
      "APP_PORT=3000",
      "APP_IMAGE=ghcr.io/example/fitgridweb:sha-2ca7f41",
      "POSTGRES_DB=fitgridweb",
      "POSTGRES_USER=fitgrid_migrate",
      "POSTGRES_PASSWORD=database-secret-at-least-thirty-two-characters",
      "APP_DATABASE_USER=fitgrid_app",
      "APP_DATABASE_PASSWORD=runtime-secret-at-least-thirty-two-characters",
      "DATABASE_URL=postgresql://fitgrid_app:runtime-secret@db:5432/fitgridweb",
      "MIGRATION_DATABASE_URL=postgresql://fitgrid_migrate:migration-secret@db:5432/fitgridweb",
      "BETTER_AUTH_SECRET=auth-secret-at-least-thirty-two-characters",
      "OWNER_REF_SECRET=owner-secret-at-least-thirty-two-characters",
      `ADMIN_OPS_DIR=${web}`,
      `ADMIN_OPS_ROOT_DIR=${rootOps}`,
      `PORTABLE_BACKUP_DIR=${backups}`,
      `PORTABLE_BACKUP_HISTORY_FILE=${history}`,
      "PORTABLE_BACKUP_MAX_BYTES=536870912",
      `BACKUP_ENCRYPTION_KEY_FILE=${backupKey}`,
    ].join("\n"),
  );
  await chmod(environmentFile, 0o600);

  await executable(
    bin,
    "docker",
    `
printf '%s\\n' "$*" >>"$DOCKER_ARGS_LOG"
lock="$FAKE_ACTIVITY_LOCK"
while ! mkdir "$lock" 2>/dev/null; do sleep 0.01; done
active=$(cat "$FAKE_ACTIVE_COUNT")
active=$((active + 1))
printf '%s\n' "$active" >"$FAKE_ACTIVE_COUNT"
maximum=$(cat "$FAKE_MAX_ACTIVE")
[ "$active" -le "$maximum" ] || printf '%s\n' "$active" >"$FAKE_MAX_ACTIVE"
rmdir "$lock"
finished=false
finish() {
  [ "$finished" = false ] || return 0
  finished=true
  while ! mkdir "$lock" 2>/dev/null; do sleep 0.01; done
  active=$(cat "$FAKE_ACTIVE_COUNT")
  printf '%s\n' "$((active - 1))" >"$FAKE_ACTIVE_COUNT"
  rmdir "$lock"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
sleep "\${FAKE_DOCKER_DELAY:-0}"
case "$*" in
  *"pg_database_size"*) printf '1024\n' ;;
  *"server_version_num"*) printf '170006\n' ;;
  *"COUNT(*)"*) printf '2|24|1|0\n' ;;
  *"psql --no-psqlrc --quiet"*)
    portable_sql=$(cat)
    if [ "\${MAINTENANCE_RESTORE_SOURCE:-}" = upload ]; then
      printf '%s\n' "$portable_sql" >"$RESTORE_SQL_LOG"
      case "$portable_sql" in
        *"COPY pg_temp.portable_rows (payload) FROM STDIN WITH (FORMAT csv);"*"INSERT INTO public.users"*) : ;;
        *) exit 17 ;;
      esac
      printf 'restore-upload\n' >>"$COMMAND_LOG"
    else
      printf '%s\n' "$portable_sql" >"$EXPORT_SQL_LOG"
      printf '%s\n' \
        '__FITGRID_PORTABLE_V3_ACCOUNTS__' \
        '__FITGRID_PORTABLE_V3_GRID_TRADES__' \
        '__FITGRID_PORTABLE_V3_IMPORT_PREVIEWS__' \
        '__FITGRID_PORTABLE_V3_INVITATIONS__' \
        '__FITGRID_PORTABLE_V3_SESSIONS__' \
        '__FITGRID_PORTABLE_V3_USERS__' '"e30="' \
        '__FITGRID_PORTABLE_V3_VERIFICATIONS__' \
        '__FITGRID_PORTABLE_V3_END__'
    fi ;;
  *"pg_dump"*)
    if [ "\${MAINTENANCE_OPERATION:-}" = restore ]; then
      printf 'rollback-snapshot\n' >>"$COMMAND_LOG"
      printf 'rollback custom dump'
    else
      printf 'portable custom dump'
    fi ;;
  *"pg_restore --list"*) cat >/dev/null; printf '37; 0 9006 TABLE DATA public users fitgrid_migrate\\n' ;;
  *"--set=migration_user="*)
    cat >/dev/null
    printf 'reset-schema\\n' >>"$COMMAND_LOG"
    if [ "$HOLD_DESTRUCTIVE" = true ]; then
      : >"$DESTRUCTIVE_HOLD_FILE"
      while [ ! -f "$DESTRUCTIVE_RELEASE_FILE" ]; do sleep 0.02; done
    fi ;;
  *" stop app"*)
    printf 'stop-app\n' >>"$COMMAND_LOG"
    if [ "\${MAINTENANCE_RESTORE_SOURCE:-}" = rollback ] && [ "$FAIL_ROLLBACK_QUIESCE" = true ]; then exit 9; fi ;;
  *"pg_terminate_backend"*) printf 'terminate-app-connections\n' >>"$COMMAND_LOG" ;;
  *"pg_restore --data-only"*) exit 71 ;;
  *"pg_restore --clean"*)
    restored_payload=$(cat)
    if [ "\${MAINTENANCE_RESTORE_SOURCE:-}" = rollback ]; then
      printf 'restore-rollback\n' >>"$COMMAND_LOG"
    else
      printf 'restore-upload\n' >>"$COMMAND_LOG"
    fi ;;
  *"prisma migrate deploy"*) printf 'migrate\n' >>"$COMMAND_LOG" ;;
  *"DELETE FROM sessions"*) printf 'delete-sessions\n' >>"$COMMAND_LOG" ;;
  *" up --no-build -d --wait app"*) printf 'start-app\n' >>"$COMMAND_LOG" ;;
esac`,
  );
  await executable(
    bin,
    "curl",
    `
printf '%s\n' "$*" >>"$HEALTH_URL_LOG"
if [ "$REQUIRE_FENCE_DURING_HEALTH" = true ] && [ ! -f "$MAINTENANCE_FENCE_FILE" ]; then
  printf 'health-unfenced\n' >>"$COMMAND_LOG"
  exit 23
fi
case "\${MAINTENANCE_HEALTH_PHASE:-}" in
  restored)
    if [ "$RESTORED_HEALTH" != true ]; then
      printf 'health-failed\n' >>"$COMMAND_LOG"
      if [ "$FAIL_ROLLBACK_AUDIT_APPEND" = true ]; then
        rm -f "$ROOT_OPS_DIRECTORY/audit.jsonl"
        mkdir "$ROOT_OPS_DIRECTORY/audit.jsonl"
      fi
      exit 22
    elif [ "$FAIL_RESTORE_SUCCESS_AUDIT_APPEND" = true ]; then
      rm -f "$ROOT_OPS_DIRECTORY/audit.jsonl"
      mkdir "$ROOT_OPS_DIRECTORY/audit.jsonl"
    fi ;;
  rollback)
    if [ "$ROLLBACK_HEALTH" != true ]; then
      printf 'health-failed\n' >>"$COMMAND_LOG"
      exit 22
    fi ;;
  snapshot-recovery)
    if [ "$SNAPSHOT_RECOVERY_HEALTH" != true ]; then
      printf 'health-failed\n' >>"$COMMAND_LOG"
      exit 22
    fi ;;
esac
case "$*" in *"https://"*) printf 'health-ok\n' >>"$COMMAND_LOG" ;; esac`,
  );
  await executable(bin, "age", `sleep "\${FAKE_AGE_DELAY:-0}"; cat`);
  await executable(
    bin,
    "sync",
    `
target=\${2:-\${1:-}}
if [ "$LOG_DURABILITY_BARRIERS" = true ]; then
  case "$target" in
    */intervention/*/rollback.dump.enc) printf 'sync-intervention-cipher\n' >>"$COMMAND_LOG" ;;
    */intervention/*/job.json) printf 'sync-intervention-job\n' >>"$COMMAND_LOG" ;;
    */intervention/*) printf 'sync-intervention-dir\n' >>"$COMMAND_LOG" ;;
    */rollback.dump.enc) printf 'sync-rollback-cipher\n' >>"$COMMAND_LOG" ;;
    */work|*/work/*) printf 'sync-work\n' >>"$COMMAND_LOG" ;;
    */completed/*.json) printf 'sync-terminal\n' >>"$COMMAND_LOG" ;;
    */completed) printf 'sync-terminal-dir\n' >>"$COMMAND_LOG" ;;
    "$MAINTENANCE_FENCE_FILE") printf 'sync-fence\n' >>"$COMMAND_LOG" ;;
    "$ROOT_OPS_DIRECTORY/maintenance.json") printf 'sync-marker\n' >>"$COMMAND_LOG" ;;
  esac
fi
if [ "$target" = "$MAINTENANCE_FENCE_FILE" ] && [ "$HOLD_FENCE_BARRIER" = true ]; then
  : >"$FENCE_HOLD_FILE"
  while [ ! -f "$FENCE_RELEASE_FILE" ]; do sleep 0.02; done
fi
if [ "$target" = "$ROOT_OPS_DIRECTORY/maintenance.json" ] \
  && [ "$HOLD_INACTIVE_MARKER_BARRIER" = true ] \
  && /usr/bin/jq -e '.active == false' "$target" >/dev/null 2>&1; then
  : >"$INACTIVE_MARKER_HOLD_FILE"
  while [ ! -f "$INACTIVE_MARKER_RELEASE_FILE" ]; do sleep 0.02; done
fi
if [ -n "$FAIL_STATUS_SYNC_STATE" ]; then
  case "$target" in
    "$STATUS_DIRECTORY"/*.json)
      if /usr/bin/jq -e --arg state "$FAIL_STATUS_SYNC_STATE" '.state == $state' "$target" >/dev/null 2>&1 \
        && [ ! -f "$FAIL_STATUS_SYNC_FILE" ]; then
        : >"$FAIL_STATUS_SYNC_FILE"
        exit 9
      fi ;;
  esac
fi
if [ "$target" = "$ROOT_OPS_DIRECTORY/audit.jsonl" ] \
  && [ -n "$FAIL_AUDIT_SYNC_OPERATION" ] \
  && tail -n 1 "$target" | /usr/bin/jq -e --arg operation "$FAIL_AUDIT_SYNC_OPERATION" '.operation == $operation' >/dev/null 2>&1; then
  if [ -z "$FAIL_AUDIT_SYNC_STATUS" ] \
    || tail -n 1 "$target" | /usr/bin/jq -e --arg status "$FAIL_AUDIT_SYNC_STATUS" '.status == $status' >/dev/null 2>&1; then
    exit 9
  fi
fi
if [ "$target" = "$ROOT_OPS_DIRECTORY/audit.jsonl" ] \
  && [ -n "$FAIL_AUDIT_SYNC_CODE" ] \
  && tail -n 1 "$target" | /usr/bin/jq -e --arg code "$FAIL_AUDIT_SYNC_CODE" '.code == $code' >/dev/null 2>&1; then
  exit 9
fi
case "$target" in *"$FAIL_SYNC_TARGET"*) [ -z "$FAIL_SYNC_TARGET" ] || exit 9 ;; esac`,
  );
  await executable(
    bin,
    "df",
    `available=$FAKE_AVAILABLE_KB
if [ "\${2:-}" = "$ROOT_OPS_DIRECTORY/claimed" ] && [ -n "$FAKE_CLAIM_AVAILABLE_KB" ]; then
  available=$FAKE_CLAIM_AVAILABLE_KB
fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/fake 20000000 1 %s 1%% /\n' "$available"`,
  );
  await executable(bin, "chown", ":");
  await executable(
    bin,
    "ln",
    `
/bin/ln "$@"
if [ "$RACE_PREPARED_REPLACEMENT" = true ]; then
  printf 'claim\n' >>"$LN_LOG"
  source=$1
  chmod 700 "$(dirname "$source")"
  rm -f "$source"
  printf 'attacker replacement after claim' >"$source"
fi`,
  );
  await executable(
    bin,
    "openssl",
    `
input=
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -in) input=$2; shift 2 ;;
    -out) output=$2; shift 2 ;;
    *) shift ;;
  esac
done
cp "$input" "$output"`,
  );
  await executable(
    bin,
    "flock",
    `printf '%s\n' "$*" >>"$FLOCK_ARGS_LOG"
[ "\${FAIL_FLOCK:-false}" != true ] || exit 1
exec /usr/bin/python3 -c 'import fcntl,sys;\ntry: fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(1)'`,
  );
  await executable(
    bin,
    "mv",
    `
source=$1
destination=$2
if [ "$FAIL_CROSS_DEVICE_MV" = true ]; then
  case "$source" in
    "$WEB_DIRECTORY"/*)
      case "$destination" in "$ROOT_OPS_DIRECTORY"/*) exit 18 ;; esac
      ;;
  esac
fi
if [ "$destination" = "$STATUS_DIRECTORY/maintenance.json" ] \
  && [ "$FAIL_MARKER_CLEAR" = true ] \
  && /usr/bin/jq -e '.active == false' "$source" >/dev/null \
  && [ ! -f "$FAIL_MARKER_FILE" ]; then
  : >"$FAIL_MARKER_FILE"
  exit 9
fi
if [ "$destination" = "$ROOT_OPS_DIRECTORY/maintenance.json" ] \
  && [ "$FAIL_ACTIVE_MARKER" = true ] \
  && /usr/bin/jq -e '.active == true' "$source" >/dev/null \
  && [ ! -f "$FAIL_ACTIVE_MARKER_FILE" ]; then
  : >"$FAIL_ACTIVE_MARKER_FILE"
  exit 9
fi
if [ -n "$FAIL_STATUS_STATE" ] \
  && [ "$destination" != "$STATUS_DIRECTORY/maintenance.json" ] \
  && /usr/bin/jq -e --arg state "$FAIL_STATUS_STATE" '.state == $state' "$source" >/dev/null \
  && [ ! -f "$FAIL_STATUS_FILE" ]; then
  : >"$FAIL_STATUS_FILE"
  exit 9
fi
case "$destination" in
  "$ROOT_OPS_DIRECTORY"/completed/*.json)
    if [ "$FAIL_COMPLETED_LEDGER" = true ]; then exit 9; fi ;;
esac
case "$destination" in
  "$STATUS_DIRECTORY"/*.json)
    case "$destination" in
      */maintenance.json|*/backups.json) : ;;
      *)
        /usr/bin/jq -er '.state | strings' "$source" >>"$TRANSITIONS_DIRECTORY/$(basename "$destination")"
        mode=$(/usr/bin/stat -f '%Lp' "$source")
        [ "$mode" = 640 ] || printf 'bad-mode:%s\n' "$mode" >>"$ATOMIC_ERRORS"
        ;;
    esac ;;
esac
exec /bin/mv "$source" "$destination"`,
  );
  await executable(bin, "id", "printf '0\n'");
  await executable(bin, "logger", ":");
  const realSha256sum = spawnSync("sh", ["-c", "command -v sha256sum"], {
    encoding: "utf8",
  }).stdout.trim();
  await executable(
    bin,
    "sha256sum",
    `printf '%s\n' "$*" >>"$SHA256_LOG"
exec "${realSha256sum}" "$@"`,
  );

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ENV_FILE: environmentFile,
    COMMAND_LOG: commandLog,
    STATUS_DIRECTORY: statuses,
    ROOT_OPS_DIRECTORY: rootOps,
    TRANSITIONS_DIRECTORY: transitionsDirectory,
    ATOMIC_ERRORS: path.join(root, "atomic-errors"),
    FAKE_ACTIVITY_LOCK: path.join(root, "activity-lock"),
    FAKE_ACTIVE_COUNT: activeCount,
    FAKE_MAX_ACTIVE: maxActive,
    FAKE_DOCKER_DELAY: "0.01",
    FITGRID_BACKUP_TIMESTAMP: "20260903T070000Z",
    MAINTENANCE_NOW_EPOCH: "1788422400",
    MAINTENANCE_CHALLENGE_TTL_SECONDS: "600",
    FITGRID_HEALTH_ATTEMPTS: "1",
    RESTORED_HEALTH: String(options.restoredHealth ?? true),
    ROLLBACK_HEALTH: String(options.rollbackHealth ?? true),
    SNAPSHOT_RECOVERY_HEALTH: "true",
    FAIL_ROLLBACK_QUIESCE: String(options.failRollbackQuiesce ?? false),
    EXPECTED_UPLOAD_CONTENT: "",
    EXPORT_SQL_LOG: path.join(root, "export.sql"),
    RESTORE_SQL_LOG: path.join(root, "restore.sql"),
    DOCKER_ARGS_LOG: dockerArgsLog,
    HEALTH_URL_LOG: healthUrlLog,
    MAINTENANCE_ROOT_UID: String(testRootUid),
    MAINTENANCE_ROOT_GID: String(testRootGid),
    WEB_DIRECTORY: web,
    FAIL_CROSS_DEVICE_MV: "false",
    FAKE_AGE_DELAY: "0",
    FAKE_AVAILABLE_KB: "10000000",
    FAKE_CLAIM_AVAILABLE_KB: "",
    LOG_DURABILITY_BARRIERS: "false",
    FAIL_SYNC_TARGET: "",
    HOLD_FENCE_BARRIER: "false",
    FENCE_HOLD_FILE: path.join(root, "fence-held"),
    FENCE_RELEASE_FILE: path.join(root, "fence-release"),
    HOLD_INACTIVE_MARKER_BARRIER: "false",
    INACTIVE_MARKER_HOLD_FILE: path.join(root, "inactive-marker-held"),
    INACTIVE_MARKER_RELEASE_FILE: path.join(root, "inactive-marker-release"),
    HOLD_DESTRUCTIVE: "false",
    DESTRUCTIVE_HOLD_FILE: path.join(root, "destructive-held"),
    DESTRUCTIVE_RELEASE_FILE: path.join(root, "destructive-release"),
    RACE_PREPARED_REPLACEMENT: "false",
    LN_LOG: path.join(root, "ln.log"),
    FAIL_MARKER_CLEAR: "false",
    FAIL_MARKER_FILE: path.join(root, "fail-marker-once"),
    FAIL_ACTIVE_MARKER: "false",
    FAIL_ACTIVE_MARKER_FILE: path.join(root, "fail-active-marker-once"),
    FAIL_STATUS_STATE: "",
    FAIL_STATUS_FILE: path.join(root, "fail-status-once"),
    FAIL_STATUS_SYNC_STATE: "",
    FAIL_STATUS_SYNC_FILE: path.join(root, "fail-status-sync-once"),
    FAIL_AUDIT_SYNC_OPERATION: "",
    FAIL_AUDIT_SYNC_STATUS: "",
    FAIL_AUDIT_SYNC_CODE: "",
    FAIL_ROLLBACK_AUDIT_APPEND: "false",
    FAIL_RESTORE_SUCCESS_AUDIT_APPEND: "false",
    FAIL_COMPLETED_LEDGER: "false",
    FAIL_FLOCK: "false",
    FLOCK_ARGS_LOG: flockArgsLog,
    SHA256_LOG: sha256Log,
    MAINTENANCE_FENCE_FILE: fence,
    REQUIRE_FENCE_DURING_HEALTH: "false",
    TMPDIR: root,
  };

  async function enqueue(job: Record<string, unknown>, secret?: string) {
    await writeFile(path.join(inbox, `${String(job.id ?? randomUUID())}.json`), JSON.stringify(job));
    if (secret !== undefined && typeof job.id === "string") {
      const secretFile = path.join(inbox, `${job.id}.secret`);
      await writeFile(secretFile, secret);
      await chmod(secretFile, 0o600);
    }
  }

  async function enqueueInspect(
    id = INSPECT_JOB,
    appImage = "ghcr.io/example/fitgridweb:sha-2ca7f41",
  ) {
    const archive = await createPortableArchive(root, appImage);
    await writeFile(path.join(uploads, `${id}.fitgridbackup`), await readFile(archive));
    await chmod(path.join(uploads, `${id}.fitgridbackup`), 0o600);
    await enqueue(
      { schemaVersion: 1, id, type: "inspect-restore", actorId: ADMIN, requestId: "01JUPLOAD" },
      "portable password",
    );
  }

  async function prepareRestore(overrides: { expiresAt?: number; users?: string } = {}) {
    const directory = path.join(prepared, INSPECT_JOB);
    await mkdir(directory);
    const payloadSource = path.join(root, `prepared-source-${randomUUID()}`);
    const users = overrides.users ?? canonicalCsvRow({
      id: ADMIN,
      name: "管理员, \"测试\"\n第二行",
      email: "admin@example.com",
      email_verified: true,
      image: null,
      username: "admin",
      role: "admin",
      status: "active",
      created_at: "2026-09-03T07:00:00.000Z",
      updated_at: "2026-09-03T07:00:00.000Z",
      literal: "\\.\nDROP TABLE users;",
    });
    await writeCanonicalPayload(payloadSource, undefined, { "users.csv": users });
    const payload = path.join(directory, "payload.tar");
    const tar = spawnSync(
      "tar",
      ["-cf", payload, ...canonicalCsvFiles, "manifest.json", "payload.sha256"],
      { cwd: payloadSource, encoding: "utf8" },
    );
    if (tar.status !== 0) throw new Error(tar.stderr);
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify(canonicalManifest()));
    const payloadBytes = await readFile(payload);
    await writeFile(
      path.join(directory, "challenge.json"),
      JSON.stringify({
        schemaVersion: 1,
        jobId: INSPECT_JOB,
        actorId: ADMIN,
        requestId: "01JUPLOAD",
        dumpSha256: createHash("sha256").update(payloadBytes).digest("hex"),
        expiresAt: overrides.expiresAt ?? 1788423000,
      }),
    );
    await Promise.all([
      chmod(path.join(directory, "payload.tar"), 0o400),
      chmod(path.join(directory, "manifest.json"), 0o400),
      chmod(path.join(directory, "challenge.json"), 0o400),
    ]);
    await chmod(directory, 0o500);
    return directory;
  }

  async function enqueueRestore() {
    await enqueue({
      schemaVersion: 1,
      id: RESTORE_JOB,
      type: "restore",
      actorId: ADMIN,
      requestId: "01JCONFIRM",
      restoreId: INSPECT_JOB,
    });
  }

  function runWorker(extraEnv: Record<string, string> = {}) {
    return spawnSync("sh", [worker], {
      cwd: projectDirectory,
      encoding: "utf8",
      env: { ...env, ...extraEnv },
    });
  }

  function runRecovery(extraEnv: Record<string, string> = {}) {
    return spawnSync("sh", [worker, "--recovery"], {
      cwd: projectDirectory,
      encoding: "utf8",
      env: { ...env, ...extraEnv },
    });
  }

  return {
    root,
    web,
    rootOps,
    environmentFile,
    inbox,
    uploads,
    statuses,
    prepared,
    backups,
    transitionsDirectory,
    commandLog,
    dockerArgsLog,
    flockArgsLog,
    audit,
    sha256Log,
    fence,
    maxActive,
    env,
    enqueue,
    enqueueInspect,
    prepareRestore,
    enqueueRestore,
    runWorker,
    runRecovery,
    status: (id: string) => readJson(path.join(statuses, `${id}.json`)),
    transitions: async (id: string) => (await readFile(path.join(transitionsDirectory, `${id}.json`), "utf8")).trim().split("\n"),
    commandSequence: async () => (await readFile(commandLog, "utf8")).trim().split("\n").filter(Boolean),
    dockerCommands: async () => (await readFile(dockerArgsLog, "utf8")).trim().split("\n").filter(Boolean),
    healthUrls: async () => (await readFile(healthUrlLog, "utf8")).trim().split("\n").filter(Boolean),
    maintenance: () => readJson(path.join(statuses, "maintenance.json")),
    rootMaintenance: () => readJson(path.join(rootOps, "maintenance.json")),
  };
}

describe("host maintenance worker", { timeout: 15_000 }, () => {
  it("waits boundedly during boot recovery and fails closed when the lock stays busy", async () => {
    const files = await workerFixture();
    await files.enqueue(
      { schemaVersion: 1, id: JOB_A, type: "backup", actorId: ADMIN, requestId: "01JLOCKED" },
      "backup password",
    );

    const ordinary = files.runWorker({ FAIL_FLOCK: "true" });
    const recovery = files.runRecovery({ FAIL_FLOCK: "true" });

    expect(ordinary.status, ordinary.stderr).toBe(0);
    expect(recovery.status).not.toBe(0);
    expect((await readFile(files.flockArgsLog, "utf8")).trim().split("\n"))
      .toEqual(["-n 9", "-w 30 9"]);
    expect(await readdir(files.inbox)).toEqual([`${JOB_A}.json`, `${JOB_A}.secret`]);
    await expect(stat(path.join(files.statuses, `${JOB_A}.json`))).rejects.toThrow();
  });

  it("does not hash published archives during an idle minute sweep", async () => {
    const files = await workerFixture();
    const filename = "fitgridweb-20260903T070000Z.fitgridbackup";
    await writeFile(path.join(files.backups, filename), "published-before-history");

    const result = files.runWorker();

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(path.join(files.statuses, "backups.json"), "utf8")).entries)
      .toEqual([]);
    expect(await readFile(files.sha256Log, "utf8")).toBe("");
  });

  it("does not hash published archives during an audit-only minute sweep", async () => {
    const files = await workerFixture();
    await writeFile(
      path.join(files.inbox, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.audit"),
      JSON.stringify({
        schemaVersion: 1,
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        event: "download-token-issued",
        actorId: ADMIN,
        requestId: "01JAUDITONLY",
        backupId: "backup-20260903",
      }),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(files.backups, "fitgridweb-20260903T070000Z.fitgridbackup"),
      "published-before-history",
    );

    const result = files.runWorker();

    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(files.sha256Log, "utf8")).toBe("");
  });

  it("reconciles published archives during boot recovery", async () => {
    const files = await workerFixture();
    const filename = "fitgridweb-20260903T070000Z.fitgridbackup";
    await writeFile(path.join(files.backups, filename), "published-before-history");

    const result = files.runRecovery();

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(path.join(files.statuses, "backups.json"), "utf8")).entries)
      .toMatchObject([{ filename, status: "ready" }]);
    expect(await readFile(files.sha256Log, "utf8")).toContain(filename);
    expect((await readFile(files.flockArgsLog, "utf8")).trim()).toBe("-w 30 9");
  });

  it.each(["queued", "claimed"])("reconciles published archives before a %s JSON job", async (location) => {
    const files = await workerFixture();
    const filename = "fitgridweb-20260902T070000Z.fitgridbackup";
    await writeFile(path.join(files.backups, filename), "published-before-history");
    const job = {
      schemaVersion: 1,
      id: JOB_A,
      type: "backup",
      actorId: ADMIN,
      requestId: "01JRECONCILE",
    };
    if (location === "queued") {
      await files.enqueue(job, "backup password");
    } else {
      const claimed = path.join(files.rootOps, "claimed");
      await mkdir(claimed);
      await chmod(claimed, 0o700);
      await writeFile(path.join(claimed, `${JOB_A}.json`), JSON.stringify(job), { mode: 0o400 });
      await chmod(path.join(claimed, `${JOB_A}.json`), 0o400);
    }

    const result = files.runWorker();

    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(files.sha256Log, "utf8")).toContain(filename);
  });

  it("serializes jobs and reports backup stages through atomic status renames", async () => {
    const files = await workerFixture();
    await files.enqueue({ schemaVersion: 1, id: JOB_A, type: "backup", actorId: ADMIN, requestId: "01JBACKUPA" }, "backup password a");
    await files.enqueue({ schemaVersion: 1, id: JOB_B, type: "backup", actorId: ADMIN, requestId: "01JBACKUPB" }, "backup password b");

    const result = files.runWorker();

    expect(result.status, result.stderr).toBe(0);
    expect(await files.transitions(JOB_A)).toEqual(["queued", "dumping", "encrypting", "ready"]);
    expect(await files.transitions(JOB_B)).toEqual(["queued", "dumping", "encrypting", "ready"]);
    expect(Number((await readFile(files.maxActive, "utf8")).trim())).toBe(1);
    await expect(readFile(path.join(files.root, "atomic-errors"), "utf8")).rejects.toThrow();
    expect(await readdir(files.inbox)).toEqual([]);
  }, 15_000);

  it("claims each queued job before execution so concurrent workers cannot run it twice", async () => {
    const files = await workerFixture();
    await files.enqueue({ schemaVersion: 1, id: JOB_A, type: "backup", actorId: ADMIN, requestId: "01JBACKUPA" }, "backup password a");
    await files.enqueue({ schemaVersion: 1, id: JOB_B, type: "backup", actorId: ADMIN, requestId: "01JBACKUPB" }, "backup password b");
    const environment = { ...files.env, FAKE_DOCKER_DELAY: "0.08" };

    const run = () => new Promise<number | null>((resolve) => {
      const child = spawn("sh", [worker], { cwd: projectDirectory, env: environment });
      child.on("exit", (code) => resolve(code));
    });
    const exits = await Promise.all([run(), run()]);

    expect(exits).toEqual([0, 0]);
    expect(await files.transitions(JOB_A)).toEqual(["queued", "dumping", "encrypting", "ready"]);
    expect(await files.transitions(JOB_B)).toEqual(["queued", "dumping", "encrypting", "ready"]);
    expect(Number((await readFile(files.maxActive, "utf8")).trim())).toBe(1);
  });

  it("claims app-owned job artifacts without relying on a cross-filesystem rename", async () => {
    const files = await workerFixture();
    await files.enqueue(
      { schemaVersion: 1, id: JOB_A, type: "backup", actorId: ADMIN, requestId: "01JEXDEV" },
      "backup password",
    );

    const result = files.runWorker({ FAIL_CROSS_DEVICE_MV: "true" });

    expect(result.status, result.stderr).toBe(0);
    expect(await files.status(JOB_A)).toMatchObject({ state: "ready" });
    expect(await readdir(files.inbox)).toEqual([]);
  });

  it("persists terminal job IDs in root state and rejects replay after cleanup", async () => {
    const files = await workerFixture();
    const job = { schemaVersion: 1, id: JOB_A, type: "backup", actorId: ADMIN, requestId: "01JREPLAY" };
    await files.enqueue(job, "first backup password");
    expect(files.runWorker().status).toBe(0);

    await files.enqueue(job, "second backup password");
    const replay = files.runWorker();

    expect(replay.status).not.toBe(0);
    expect(await files.transitions(JOB_A)).toEqual(["queued", "dumping", "encrypting", "ready"]);
    expect(await readdir(files.inbox)).toEqual([]);
    const terminal = path.join(files.rootOps, "completed", `${JOB_A}.json`);
    expect(await readJson(terminal)).toMatchObject({ id: JOB_A, state: "ready" });
    expect((await stat(terminal)).mode & 0o777).toBe(0o400);
    expect(await readFile(files.audit, "utf8")).toContain('"code":"REPLAYED_JOB"');
  });

  it("inspects an upload into immutable, expiring prepared state and removes both secrets", async () => {
    const files = await workerFixture();
    await files.enqueueInspect();

    const result = files.runWorker({ MAINTENANCE_CHALLENGE_TTL_SECONDS: "900" });

    expect(result.status, result.stderr).toBe(0);
    expect(await files.transitions(INSPECT_JOB)).toEqual(["queued", "inspecting", "awaiting-confirmation"]);
    const statusJson = await files.status(INSPECT_JOB);
    expect(statusJson).toMatchObject({
      id: INSPECT_JOB,
      actorId: ADMIN,
      requestId: "01JUPLOAD",
      state: "awaiting-confirmation",
      expiresAt: 1788423000,
      preview: { users: 1, gridTrades: 0, invitations: 0, importPreviews: 0 },
    });
    const preparedDirectory = path.join(files.prepared, INSPECT_JOB);
    expect((await stat(path.join(preparedDirectory, "payload.tar"))).mode & 0o777).toBe(0o400);
    expect((await stat(path.join(preparedDirectory, "manifest.json"))).mode & 0o777).toBe(0o400);
    expect((await stat(path.join(preparedDirectory, "challenge.json"))).mode & 0o777).toBe(0o400);
    expect((await stat(preparedDirectory)).mode & 0o777).toBe(0o500);
    expect(await readdir(files.uploads)).toEqual([]);
    expect(await readdir(files.inbox)).toEqual([]);
    await expect(stat(path.join(files.rootOps, "completed", `${INSPECT_JOB}.json`))).rejects.toThrow();
  });

  it.each([
    ["status publication", { FAIL_STATUS_STATE: "failed" }],
    ["terminal ledger publication", { FAIL_COMPLETED_LEDGER: "true" }],
  ])("destroys inspected plaintext and reconciles admission when expiry %s fails", async (_failure, failureEnv) => {
    const files = await workerFixture();
    await files.enqueueInspect();
    expect(files.runWorker().status).toBe(0);
    await writeFile(path.join(files.statuses, "active-job.json"), JSON.stringify({
      schemaVersion: 1,
      jobId: INSPECT_JOB,
      createdAt: "2026-09-03T07:00:00Z",
    }));

    const expiry = files.runWorker({
      MAINTENANCE_NOW_EPOCH: "1788424000",
      ...failureEnv,
    });

    expect(expiry.status).not.toBe(0);
    await expect(stat(path.join(files.prepared, INSPECT_JOB))).rejects.toThrow();
    await expect(stat(path.join(files.statuses, "active-job.json"))).rejects.toThrow();
  });

  it("uses a root-owned claimed upload after the app recreates its upload pathname", async () => {
    const files = await workerFixture();
    await files.enqueueInspect();
    const claimedUpload = path.join(files.rootOps, "claimed", `${INSPECT_JOB}.fitgridbackup`);
    const publicUpload = path.join(files.uploads, `${INSPECT_JOB}.fitgridbackup`);
    const workerExit = new Promise<number | null>((resolve) => {
      const child = spawn("sh", [worker], {
        cwd: projectDirectory,
        env: { ...files.env, FAKE_AGE_DELAY: "0.5" },
      });
      child.on("exit", resolve);
    });

    const claimed = await waitForFile(claimedUpload);
    expect(claimed.uid).toBe(testRootUid);
    expect(claimed.gid).toBe(testRootGid);
    expect(claimed.mode & 0o777).toBe(0o400);
    await writeFile(publicUpload, "app replacement after claim");

    expect(await workerExit).toBe(0);
    expect(await files.status(INSPECT_JOB)).toMatchObject({ state: "awaiting-confirmation" });
  });

  it("reserves headroom before the root-owned upload copy at its space boundary", async () => {
    const files = await workerFixture();
    await files.enqueueInspect();
    const upload = path.join(files.uploads, `${INSPECT_JOB}.fitgridbackup`);
    const requiredKb = Math.ceil(((await stat(upload)).size + 64 * 1024 * 1024) / 1024);

    const result = files.runWorker({ FAKE_CLAIM_AVAILABLE_KB: String(requiredKb - 1) });

    expect(result.status).not.toBe(0);
    expect(await files.status(INSPECT_JOB)).toMatchObject({ state: "failed", code: "INSUFFICIENT_DISK_SPACE" });
    expect(await files.commandSequence()).toEqual([]);
    await expect(stat(path.join(files.rootOps, "claimed", `${INSPECT_JOB}.fitgridbackup`)))
      .rejects.toThrow();

    const boundary = await workerFixture();
    await boundary.enqueueInspect();
    const boundaryUpload = path.join(boundary.uploads, `${INSPECT_JOB}.fitgridbackup`);
    const boundaryRequiredKb = Math.ceil(((await stat(boundaryUpload)).size + 64 * 1024 * 1024) / 1024);

    const accepted = boundary.runWorker({ FAKE_CLAIM_AVAILABLE_KB: String(boundaryRequiredKb) });

    expect(accepted.status, accepted.stderr).toBe(0);
    expect(await boundary.status(INSPECT_JOB)).toMatchObject({ state: "awaiting-confirmation" });
  });

  it("never publishes an uploaded manifest app image into the app-readable status layer", async () => {
    const files = await workerFixture();
    const hostileImage = "registry-user:portable-password@/var/lib/private-host/image";
    await files.enqueueInspect(INSPECT_JOB, hostileImage);

    const result = files.runWorker();

    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(path.join(files.prepared, INSPECT_JOB, "manifest.json"), "utf8"))
      .toContain(hostileImage);
    const rawStatus = await readFile(path.join(files.statuses, `${INSPECT_JOB}.json`), "utf8");
    expect(rawStatus).not.toContain(hostileImage);
    expect(rawStatus).not.toContain("portable-password");
    expect(rawStatus).not.toContain("/var/lib/private-host");

    const publicFileContents: string[] = [];
    for (const directory of [files.inbox, files.uploads, files.statuses]) {
      for (const name of await readdir(directory)) {
        const candidate = path.join(directory, name);
        if ((await stat(candidate)).isFile()) publicFileContents.push(await readFile(candidate, "utf8"));
      }
    }
    expect(publicFileContents.join("\n")).not.toContain(hostileImage);

    const gateway = new FileMaintenanceGateway({
      adminOpsDirectory: files.web,
      portableBackupDirectory: files.backups,
      portableBackupHistoryFile: path.join(files.statuses, "backups.json"),
      maxUploadBytes: 536_870_912,
    });
    const gatewaySerializations = JSON.stringify([
      await gateway.getJob(INSPECT_JOB),
      await gateway.getMaintenanceMode(),
      await gateway.listBackups(),
    ]);
    expect(gatewaySerializations).not.toContain(hostileImage);
    expect(gatewaySerializations).not.toContain("portable-password");
    expect(gatewaySerializations).not.toContain("/var/lib/private-host");
  });

  it.each([
    ["group-writable root state", async (files: Awaited<ReturnType<typeof workerFixture>>) => chmod(files.rootOps, 0o770), {}],
    ["group-writable claimed state", async (files: Awaited<ReturnType<typeof workerFixture>>) => {
      const claimed = path.join(files.rootOps, "claimed");
      await mkdir(claimed);
      await chmod(claimed, 0o770);
    }, {}],
    ["unexpected root-state owner", async () => undefined, { MAINTENANCE_ROOT_UID: String(testRootUid + 1) }],
  ])("fails closed for %s", async (_caseName, arrange, extraEnv) => {
    const files = await workerFixture();
    await arrange(files);

    const result = files.runWorker(extraEnv);

    expect(result.status).not.toBe(0);
    expect(await files.commandSequence()).toEqual([]);
  });

  it("rejects a root directory reached through a non-canonical symlink parent", async () => {
    const files = await workerFixture();
    const alias = path.join(files.root, "root-alias");
    await symlink(files.root, alias);
    const environment = await readFile(files.environmentFile, "utf8");
    await writeFile(files.environmentFile, environment.replace(
      `ADMIN_OPS_ROOT_DIR=${files.rootOps}`,
      `ADMIN_OPS_ROOT_DIR=${path.join(alias, "root")}`,
    ));

    const result = files.runWorker();

    expect(result.status).not.toBe(0);
    expect(await files.commandSequence()).toEqual([]);
  });

  it("restores from a pinned inode when the prepared pathname is replaced after claiming", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker({
      RACE_PREPARED_REPLACEMENT: "true",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "succeeded" });
    expect(await readFile(path.join(files.root, "ln.log"), "utf8")).toBe("claim\n");
  });

  it("recreates the reviewed schema before restoring only portable table data", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker();

    expect(result.status, result.stderr).toBe(0);
    expect(await files.commandSequence()).toEqual([
      "stop-app",
      "terminate-app-connections",
      "rollback-snapshot",
      "reset-schema",
      "migrate",
      "restore-upload",
      "delete-sessions",
      "start-app",
      "health-ok",
    ]);
    const commands = await files.dockerCommands();
    const portableRestore = commands.find((command) => command.includes("psql --no-psqlrc --quiet"));
    expect(portableRestore).toContain("--set=ON_ERROR_STOP=1");
    expect(commands.some((command) => command.includes("pg_restore --data-only"))).toBe(false);
    const restoreSql = await readFile(path.join(files.root, "restore.sql"), "utf8");
    expect(restoreSql).toContain("COPY pg_temp.portable_rows (payload) FROM STDIN WITH (FORMAT csv);");
    expect(restoreSql).toContain("INSERT INTO public.users");
    expect(restoreSql).toContain("INSERT INTO public.sessions");
    expect(restoreSql.match(/COPY pg_temp\.portable_rows/g)).toHaveLength(7);
    expect(restoreSql).not.toContain("DROP TABLE users");
    expect(restoreSql).not.toContain("管理员");
    expect(restoreSql).toContain(canonicalCsvRow({
      id: ADMIN,
      name: "管理员, \"测试\"\n第二行",
      email: "admin@example.com",
      email_verified: true,
      image: null,
      username: "admin",
      role: "admin",
      status: "active",
      created_at: "2026-09-03T07:00:00.000Z",
      updated_at: "2026-09-03T07:00:00.000Z",
      literal: "\\.\nDROP TABLE users;",
    }).trim());
  });

  it("refuses restore peak space before snapshotting or touching the live database", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker({ FAKE_AVAILABLE_KB: "1024" });

    expect(result.status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "failed", code: "INSUFFICIENT_DISK_SPACE" });
    expect(await files.commandSequence()).toEqual([]);
    await expect(stat(files.fence)).rejects.toThrow();
  });

  it("durably barriers rollback evidence, fence, and marker before destructive commands", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker({ LOG_DURABILITY_BARRIERS: "true" });

    expect(result.status, result.stderr).toBe(0);
    const sequence = await files.commandSequence();
    const stop = sequence.indexOf("stop-app");
    const snapshot = sequence.indexOf("rollback-snapshot");
    const reset = sequence.indexOf("reset-schema");
    for (const barrier of ["sync-fence", "sync-marker"]) {
      expect(sequence.indexOf(barrier), `${barrier}: ${sequence.join(", ")}`).toBeGreaterThan(-1);
      expect(sequence.indexOf(barrier)).toBeLessThan(stop);
    }
    for (const barrier of ["sync-rollback-cipher", "sync-work"]) {
      expect(sequence.indexOf(barrier), `${barrier}: ${sequence.join(", ")}`).toBeGreaterThan(-1);
      expect(sequence.indexOf(barrier)).toBeGreaterThan(snapshot);
      expect(sequence.indexOf(barrier)).toBeLessThan(reset);
    }
  });

  it("restarts and verifies the unchanged app before reporting a snapshot failure", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker({ FAIL_SYNC_TARGET: "rollback.dump.enc" });

    expect(result.status).not.toBe(0);
    expect(await files.commandSequence()).toEqual([
      "stop-app",
      "terminate-app-connections",
      "rollback-snapshot",
      "start-app",
      "health-ok",
    ]);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "failed", code: "SNAPSHOT_FAILED" });
    expect(await files.maintenance()).toMatchObject({ active: false });
    await expect(stat(files.fence)).rejects.toThrow();
  });

  it("requires intervention when the old app cannot be verified after a snapshot failure", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker({
      FAIL_SYNC_TARGET: "rollback.dump.enc",
      SNAPSHOT_RECOVERY_HEALTH: "false",
    });

    expect(result.status).not.toBe(0);
    expect(await files.commandSequence()).toEqual([
      "stop-app",
      "terminate-app-connections",
      "rollback-snapshot",
      "start-app",
      "health-failed",
    ]);
    expect(await files.status(RESTORE_JOB)).toMatchObject({
      state: "intervention-required",
      code: "SNAPSHOT_RECOVERY_FAILED",
    });
    expect(await files.rootMaintenance()).toMatchObject({ active: true, jobId: RESTORE_JOB });
    expect((await stat(files.fence)).mode & 0o777).toBe(0o644);
  });

  it("checks the configured non-standard public HTTPS port after restore", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();

    const environment = await readFile(files.environmentFile, "utf8");
    await writeFile(files.environmentFile, environment
      .replace("PUBLIC_HTTPS_PORT=443", "PUBLIC_HTTPS_PORT=10256")
      .replace("PUBLIC_PORT_SUFFIX=", "PUBLIC_PORT_SUFFIX=:10256"));

    const result = files.runWorker();

    expect(result.status, result.stderr).toBe(0);
    expect(await files.healthUrls()).toContain(
      "--fail --silent --show-error --max-time 10 https://grid.example.com:10256/fitgrid/api/v1/health",
    );
  });

  it("enters intervention when the fence cannot become durable before marker activation", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker({ FAIL_SYNC_TARGET: "maintenance.flag" });

    expect(result.status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({
      state: "intervention-required",
      code: "FENCE_ACTIVATION_FAILED",
    });
    expect(await files.rootMaintenance()).toMatchObject({ active: true, jobId: RESTORE_JOB });
    expect((await stat(files.fence)).mode & 0o777).toBe(0o644);
    expect((await readdir(path.join(files.rootOps, "intervention", RESTORE_JOB))).sort())
      .toEqual(["job.json"]);
    expect(await files.commandSequence()).toEqual([]);
  });

  it.each([
    ["active marker", { FAIL_ACTIVE_MARKER: "true" }, "MARKER_ACTIVATION_FAILED", []],
    ["restoring status", { FAIL_STATUS_STATE: "restoring" }, "STATUS_PUBLISH_FAILED", [
      "stop-app", "terminate-app-connections", "rollback-snapshot",
    ]],
  ])("does not touch the live database when %s publication fails", async (_failure, failureEnv, code, commands) => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker(failureEnv);

    expect(result.status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "intervention-required", code });
    expect(await files.rootMaintenance()).toMatchObject({ active: true, jobId: RESTORE_JOB });
    expect((await stat(files.fence)).mode & 0o777).toBe(0o644);
    expect(await files.commandSequence()).toEqual(commands);
  });

  it.each([
    ["append", true, {}],
    ["filesystem sync", false, { FAIL_AUDIT_SYNC_CODE: "RESTORE_CONFIRMED" }],
  ])("does not begin destructive restore when its confirmation audit %s fails", async (_failure, failAppend, failureEnv) => {
    const files = await workerFixture();
    if (failAppend) await mkdir(files.audit);
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker(failureEnv);

    expect(result.status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({
      state: "intervention-required",
      code: "AUDIT_PERSIST_FAILED",
    });
    expect(await files.commandSequence()).toEqual([
      "stop-app",
      "terminate-app-connections",
      "rollback-snapshot",
    ]);
    expect(await files.rootMaintenance()).toMatchObject({ active: true, jobId: RESTORE_JOB });
    expect((await stat(files.fence)).mode & 0o777).toBe(0o644);
    expect(await stat(path.join(files.rootOps, "intervention", RESTORE_JOB, "rollback.dump.enc"))).toBeDefined();
  });

  it("rolls production back exactly once when restored application health fails", async () => {
    const files = await workerFixture({ restoredHealth: false, rollbackHealth: true });
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker();

    expect(result.status, result.stderr).toBe(0);
    expect(await files.commandSequence()).toEqual([
      "stop-app",
      "terminate-app-connections",
      "rollback-snapshot",
      "reset-schema",
      "migrate",
      "restore-upload",
      "delete-sessions",
      "start-app",
      "health-failed",
      "stop-app",
      "terminate-app-connections",
      "restore-rollback",
      "migrate",
      "start-app",
      "health-ok",
    ]);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "failed", rolledBack: true, code: "RESTORE_FAILED" });
    expect(await files.maintenance()).toMatchObject({ active: false });
    await expect(stat(path.join(files.prepared, INSPECT_JOB))).rejects.toThrow();
    await expect(stat(path.join(files.rootOps, "intervention", RESTORE_JOB))).rejects.toThrow();
  });

  it.each([
    ["status publication", { FAIL_STATUS_STATE: "rollback" }, "STATUS_PUBLISH_FAILED"],
    ["audit append", { FAIL_ROLLBACK_AUDIT_APPEND: "true" }, "AUDIT_PERSIST_FAILED"],
    ["audit filesystem sync", { FAIL_AUDIT_SYNC_CODE: "ROLLBACK_STARTED" }, "AUDIT_PERSIST_FAILED"],
  ])("does not begin rollback when its start %s fails", async (_failure, failureEnv, code) => {
    const files = await workerFixture({ restoredHealth: false, rollbackHealth: true });
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker(failureEnv);

    expect(result.status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "intervention-required", code });
    expect(await files.commandSequence()).toEqual([
      "stop-app",
      "terminate-app-connections",
      "rollback-snapshot",
      "reset-schema",
      "migrate",
      "restore-upload",
      "delete-sessions",
      "start-app",
      "health-failed",
    ]);
    expect(await files.rootMaintenance()).toMatchObject({ active: true, jobId: RESTORE_JOB });
    expect((await stat(files.fence)).mode & 0o777).toBe(0o644);
    expect(await stat(path.join(files.rootOps, "intervention", RESTORE_JOB, "rollback.dump.enc"))).toBeDefined();
  });

  it("keeps external traffic fenced through restored health and clears only after finalization", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker({ REQUIRE_FENCE_DURING_HEALTH: "true" });

    expect(result.status, result.stderr).toBe(0);
    expect(await files.commandSequence()).not.toContain("health-unfenced");
    await expect(stat(files.fence)).rejects.toThrow();
  });

  it("leaves maintenance active when restore and rollback both fail", async () => {
    const files = await workerFixture({ restoredHealth: false, rollbackHealth: false });
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker({ LOG_DURABILITY_BARRIERS: "true" });

    expect(result.status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({
      state: "intervention-required",
      rolledBack: false,
      code: "ROLLBACK_FAILED",
    });
    expect(await files.maintenance()).toMatchObject({ active: true, jobId: RESTORE_JOB });
    expect((await stat(path.dirname(files.fence))).mode & 0o777).toBe(0o755);
    expect((await stat(files.fence)).mode & 0o777).toBe(0o644);
    expect((await files.commandSequence()).filter((entry) => entry === "restore-rollback")).toHaveLength(1);
    await expect(stat(path.join(files.prepared, INSPECT_JOB))).rejects.toThrow();
    const intervention = path.join(files.rootOps, "intervention", RESTORE_JOB);
    expect((await readdir(intervention)).sort()).toEqual(["job.json", "rollback.dump.enc"]);
    expect((await stat(intervention)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(intervention, "rollback.dump.enc"))).mode & 0o777).toBe(0o400);
    expect(await readFile(path.join(intervention, "rollback.dump.enc"), "utf8")).toBe("rollback custom dump");
    expect(await files.commandSequence()).toEqual(expect.arrayContaining([
      "sync-intervention-cipher",
      "sync-intervention-job",
      "sync-intervention-dir",
    ]));

    expect(files.runWorker().status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "intervention-required", code: "ROLLBACK_FAILED" });
    expect((await files.commandSequence()).filter((entry) => entry === "restore-rollback")).toHaveLength(1);
  });

  it("stops draining before a queued second job after intervention", async () => {
    const files = await workerFixture({ restoredHealth: false, rollbackHealth: false });
    await files.prepareRestore();
    await files.enqueueRestore();
    await files.enqueue({
      schemaVersion: 1,
      id: JOB_AFTER_INTERVENTION,
      type: "backup",
      actorId: ADMIN,
      requestId: "01JAFTERFAIL",
    }, "queued backup password");

    const result = files.runWorker();

    expect(result.status).not.toBe(0);
    expect(await readdir(files.inbox)).toEqual([
      `${JOB_AFTER_INTERVENTION}.json`,
      `${JOB_AFTER_INTERVENTION}.secret`,
    ]);
    await expect(stat(path.join(files.statuses, `${JOB_AFTER_INTERVENTION}.json`))).rejects.toThrow();
    expect((await files.commandSequence()).filter((entry) => entry === "rollback-snapshot")).toHaveLength(1);
  });

  it("does not write rollback data when rollback quiescing fails", async () => {
    const files = await workerFixture({ restoredHealth: false, failRollbackQuiesce: true });
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker();

    expect(result.status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "intervention-required", code: "ROLLBACK_FAILED" });
    expect(await files.commandSequence()).toEqual([
      "stop-app",
      "terminate-app-connections",
      "rollback-snapshot",
      "reset-schema",
      "migrate",
      "restore-upload",
      "delete-sessions",
      "start-app",
      "health-failed",
      "stop-app",
    ]);
  });

  it("enters auditable intervention when maintenance marker clearing fails", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker({ FAIL_MARKER_CLEAR: "true" });

    expect(result.status).not.toBe(0);
    expect(await files.maintenance()).toMatchObject({ active: true, jobId: RESTORE_JOB });
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "intervention-required", code: "MARKER_CLEAR_FAILED" });
    expect(await stat(path.join(files.rootOps, "intervention", RESTORE_JOB, "rollback.dump.enc"))).toBeDefined();
  });

  it.each([
    ["atomic rename", { FAIL_STATUS_STATE: "succeeded" }],
    ["durability sync", { FAIL_STATUS_SYNC_STATE: "succeeded" }],
  ])("reasserts maintenance when terminal success status %s fails", async (_failure, failureEnv) => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker(failureEnv);

    expect(result.status).not.toBe(0);
    expect(await files.maintenance()).toMatchObject({ active: true, jobId: RESTORE_JOB });
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "intervention-required", code: "STATUS_PUBLISH_FAILED" });
    expect(await stat(path.join(files.rootOps, "intervention", RESTORE_JOB, "rollback.dump.enc"))).toBeDefined();
  });

  it.each([
    ["restore success", {}, "restore", "succeeded"],
    ["rollback success", { restoredHealth: false }, "rollback", "succeeded"],
  ])("keeps maintenance fenced when the %s audit cannot be made durable", async (_caseName, options, operation, status) => {
    const files = await workerFixture(options);
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker({
      FAIL_AUDIT_SYNC_OPERATION: operation,
      FAIL_AUDIT_SYNC_STATUS: status,
    });

    expect(result.status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({
      state: "intervention-required",
      code: "AUDIT_PERSIST_FAILED",
    });
    expect(await files.rootMaintenance()).toMatchObject({ active: true, jobId: RESTORE_JOB });
    expect((await stat(files.fence)).mode & 0o777).toBe(0o644);
    expect(await stat(path.join(files.rootOps, "intervention", RESTORE_JOB, "rollback.dump.enc"))).toBeDefined();
  });

  it("keeps maintenance fenced when the success audit append fails", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker({ FAIL_RESTORE_SUCCESS_AUDIT_APPEND: "true" });

    expect(result.status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({
      state: "intervention-required",
      code: "AUDIT_PERSIST_FAILED",
    });
    expect(await files.rootMaintenance()).toMatchObject({ active: true, jobId: RESTORE_JOB });
    expect((await stat(files.fence)).mode & 0o777).toBe(0o644);
    expect(await stat(path.join(files.rootOps, "intervention", RESTORE_JOB, "rollback.dump.enc"))).toBeDefined();
  });

  it("fails closed and retains recovery state when the completed ledger cannot publish after restore", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker({ FAIL_COMPLETED_LEDGER: "true" });

    expect(result.status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({
      state: "intervention-required",
      code: "TERMINAL_STATE_WRITE_FAILED",
    });
    expect(await files.rootMaintenance()).toMatchObject({ schemaVersion: 1, active: true, jobId: RESTORE_JOB });
    expect(await files.maintenance()).toMatchObject({ schemaVersion: 1, active: true, jobId: RESTORE_JOB });
    expect((await stat(path.join(files.rootOps, "maintenance.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(files.statuses, "maintenance.json"))).mode & 0o777).toBe(0o640);
    const intervention = path.join(files.rootOps, "intervention", RESTORE_JOB);
    expect((await readdir(intervention)).sort()).toEqual(["job.json", "rollback.dump.enc"]);
    expect(await readFile(path.join(intervention, "rollback.dump.enc"), "utf8")).toBe("rollback custom dump");
    expect((await stat(path.join(intervention, "rollback.dump.enc"))).mode & 0o777).toBe(0o400);
    expect((await stat(path.join(intervention, "job.json"))).mode & 0o777).toBe(0o400);
    await expect(stat(path.join(files.rootOps, "completed", `${RESTORE_JOB}.json`))).rejects.toThrow();
    await expect(stat(path.join(files.prepared, INSPECT_JOB))).rejects.toThrow();
    expect(await readdir(files.inbox)).toEqual([]);
    expect(await readdir(files.uploads)).toEqual([]);
    expect(await readdir(path.join(files.rootOps, "claimed"))).toEqual([]);
    expect(await readdir(path.join(files.rootOps, "work"))).toEqual([]);

    const outsideSecret = path.join(files.root, "outside-secret");
    await writeFile(outsideSecret, "must survive orphan cleanup");
    await writeFile(path.join(files.inbox, `${RESTORE_JOB}.secret`), "late restore secret");
    await symlink(outsideSecret, path.join(files.rootOps, "claimed", `${RESTORE_JOB}.secret`));
    await writeFile(path.join(files.uploads, `${RESTORE_JOB}.fitgridbackup`), "late restore upload");
    const commandsBeforeReboot = await files.commandSequence();
    expect(files.runWorker().status).not.toBe(0);
    expect(await files.commandSequence()).toEqual(commandsBeforeReboot);
    expect(await readdir(files.inbox)).toEqual([]);
    expect(await readdir(files.uploads)).toEqual([]);
    expect(await readdir(path.join(files.rootOps, "claimed"))).toEqual([]);
    expect(await readFile(outsideSecret, "utf8")).toBe("must survive orphan cleanup");
    expect((await readdir(intervention)).sort()).toEqual(["job.json", "rollback.dump.enc"]);
    expect(await readFile(path.join(intervention, "rollback.dump.enc"), "utf8")).toBe("rollback custom dump");
  });

  it("does not attempt a terminal ledger while inspection awaits confirmation", async () => {
    const files = await workerFixture();
    await files.enqueueInspect();

    const result = files.runWorker({ FAIL_COMPLETED_LEDGER: "true" });

    expect(result.status, result.stderr).toBe(0);
    expect(await files.status(INSPECT_JOB)).toMatchObject({ state: "awaiting-confirmation" });
    await expect(stat(files.fence)).rejects.toThrow();
    await expect(stat(path.join(files.rootOps, "completed", `${INSPECT_JOB}.json`))).rejects.toThrow();
    await expect(stat(path.join(files.rootOps, "intervention", INSPECT_JOB))).rejects.toThrow();
    expect(await stat(path.join(files.prepared, INSPECT_JOB))).toBeDefined();
    expect(await readdir(files.inbox)).toEqual([]);
    expect(await readdir(files.uploads)).toEqual([]);
    expect(await readdir(path.join(files.rootOps, "claimed"))).toEqual([]);
    expect(await readdir(path.join(files.rootOps, "work"))).toEqual([]);
  });

  it("uses root-owned active maintenance after the public mirror is deleted or forged inactive", async () => {
    const files = await workerFixture({ restoredHealth: false, rollbackHealth: false });
    await files.prepareRestore();
    await files.enqueueRestore();
    expect(files.runWorker().status).not.toBe(0);
    expect(await files.rootMaintenance()).toMatchObject({ schemaVersion: 1, active: true, jobId: RESTORE_JOB });

    await unlink(path.join(files.statuses, "maintenance.json"));
    await files.enqueue({ schemaVersion: 1, id: JOB_A, type: "backup", actorId: ADMIN, requestId: "01JBLOCKED" });
    const commandsBeforeReboot = await files.commandSequence();
    expect(files.runWorker().status).not.toBe(0);
    expect(await files.commandSequence()).toEqual(commandsBeforeReboot);
    expect(await readdir(files.inbox)).toEqual([`${JOB_A}.json`]);
    expect(await files.maintenance()).toMatchObject({ schemaVersion: 1, active: true, jobId: RESTORE_JOB });

    await writeFile(path.join(files.statuses, "maintenance.json"), JSON.stringify({
      schemaVersion: 1,
      active: false,
      updatedAt: "2026-09-03T00:00:00Z",
    }));
    expect(files.runWorker().status).not.toBe(0);
    expect(await readdir(files.inbox)).toEqual([`${JOB_A}.json`]);
    expect(await files.rootMaintenance()).toMatchObject({ schemaVersion: 1, active: true, jobId: RESTORE_JOB });
    expect(await files.maintenance()).toMatchObject({ schemaVersion: 1, active: true, jobId: RESTORE_JOB });
  });

  it("admits jobs from root-owned inactive maintenance despite a forged active public mirror", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();
    expect(files.runWorker().status).toBe(0);
    expect(await files.rootMaintenance()).toMatchObject({ schemaVersion: 1, active: false });

    await writeFile(path.join(files.statuses, "maintenance.json"), JSON.stringify({
      schemaVersion: 1,
      active: true,
      jobId: JOB_B,
      updatedAt: "2026-09-03T00:00:00Z",
    }));
    await files.enqueue(
      { schemaVersion: 1, id: JOB_A, type: "backup", actorId: ADMIN, requestId: "01JROOTAUTH" },
      "backup password",
    );

    const result = files.runWorker({ FITGRID_BACKUP_TIMESTAMP: "20260903T080000Z" });

    expect(result.status, result.stderr).toBe(0);
    expect(await files.status(JOB_A)).toMatchObject({ state: "ready" });
    expect(await files.rootMaintenance()).toMatchObject({ schemaVersion: 1, active: false });
    expect(await files.maintenance()).toMatchObject({ schemaVersion: 1, active: false });
  });

  it.each([
    ["invalid JSON", "{not-json", `${JOB_A}.json`],
    ["unknown operation", JSON.stringify({ schemaVersion: 1, id: JOB_A, type: "shell", actorId: ADMIN, requestId: "01JBAD" }), `${JOB_A}.json`],
    ["non-UUID id", JSON.stringify({ schemaVersion: 1, id: "../escape", type: "backup", actorId: ADMIN, requestId: "01JBAD" }), "malformed.json"],
    ["user-controlled path", JSON.stringify({ schemaVersion: 1, id: JOB_A, type: "backup", actorId: ADMIN, requestId: "01JBAD", outputPath: "/tmp/stolen" }), `${JOB_A}.json`],
  ])("rejects %s without executing host commands", async (_caseName, contents, filename) => {
    const files = await workerFixture();
    await writeFile(path.join(files.inbox, filename), contents);

    const result = files.runWorker();

    expect(result.status).not.toBe(0);
    expect(await files.commandSequence()).toEqual([]);
    expect(await readdir(files.inbox)).toEqual([]);
    expect(await readFile(files.audit, "utf8")).toContain('"code":"INVALID_JOB"');
  });

  it("rejects a replaced prepared payload before snapshotting or stopping the app", async () => {
    const files = await workerFixture();
    const directory = await files.prepareRestore();
    await chmod(directory, 0o700);
    await chmod(path.join(directory, "payload.tar"), 0o600);
    await writeFile(path.join(directory, "payload.tar"), "attacker replacement");
    await chmod(path.join(directory, "payload.tar"), 0o400);
    await chmod(directory, 0o500);
    await files.enqueueRestore();

    const result = files.runWorker();

    expect(result.status).not.toBe(0);
    expect(await files.commandSequence()).toEqual([]);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "failed", code: "PREPARED_DUMP_CHANGED" });
  });

  it("rejects an expired challenge before maintenance and destroys its prepared plaintext", async () => {
    const files = await workerFixture();
    await files.prepareRestore({ expiresAt: 1788422399 });
    await files.enqueueRestore();

    const result = files.runWorker();

    expect(result.status).not.toBe(0);
    expect(await files.commandSequence()).toEqual([]);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "failed", code: "CHALLENGE_EXPIRED" });
    await expect(stat(path.join(files.prepared, INSPECT_JOB))).rejects.toThrow();
  });

  it("expires inspected plaintext on a later worker run without needing a restore job", async () => {
    const files = await workerFixture();
    await files.prepareRestore({ expiresAt: 1788422399 });

    const result = files.runWorker();

    expect(result.status).toBe(0);
    expect(await files.status(INSPECT_JOB)).toMatchObject({ state: "failed", code: "CHALLENGE_EXPIRED" });
    await expect(stat(path.join(files.prepared, INSPECT_JOB))).rejects.toThrow();
    expect(await files.commandSequence()).toEqual([]);
  });

  it("fails and cleans a stale claimed job that never entered maintenance after reboot", async () => {
    const files = await workerFixture();
    const claimed = path.join(files.rootOps, "claimed");
    await mkdir(claimed);
    await chmod(claimed, 0o700);
    await writeFile(path.join(claimed, `${JOB_A}.json`), JSON.stringify({
      schemaVersion: 1,
      id: JOB_A,
      type: "backup",
      actorId: ADMIN,
      requestId: "01JSTALE",
    }));
    await chmod(path.join(claimed, `${JOB_A}.json`), 0o400);
    await writeFile(path.join(claimed, `${JOB_A}.secret`), "do not retain me");
    await writeFile(path.join(files.inbox, `${JOB_A}.secret`), "nor me");

    const result = files.runWorker();

    expect(result.status, result.stderr).toBe(0);
    expect(await files.status(JOB_A)).toMatchObject({ state: "failed", code: "STALE_JOB" });
    expect(await readdir(claimed)).toEqual([]);
    expect(await readdir(files.inbox)).toEqual([]);
    expect(await files.commandSequence()).toEqual([]);
  });

  it("quarantines a corrupt root claim and keeps boot fenced for explicit reconciliation", async () => {
    const files = await workerFixture();
    const claimed = path.join(files.rootOps, "claimed");
    await mkdir(claimed);
    await chmod(claimed, 0o700);
    const corruptClaim = path.join(claimed, `${JOB_A}.json`);
    await writeFile(corruptClaim, "{not-json");
    await chmod(corruptClaim, 0o400);
    await writeFile(path.join(claimed, `${JOB_A}.secret`), "preserve with corrupt claim");
    await chmod(path.join(claimed, `${JOB_A}.secret`), 0o400);
    await writeFile(path.join(files.statuses, "active-job.json"), JSON.stringify({
      schemaVersion: 1,
      jobId: JOB_A,
      createdAt: "2026-09-03T07:00:00Z",
    }));

    const recovery = files.runRecovery();

    expect(recovery.status).not.toBe(0);
    const quarantined = path.join(files.rootOps, "intervention", "corrupt-claims", `${JOB_A}.json`);
    expect(await readFile(quarantined, "utf8")).toBe("{not-json");
    expect((await stat(quarantined)).mode & 0o777).toBe(0o400);
    expect(await readFile(path.join(claimed, `${JOB_A}.secret`), "utf8"))
      .toBe("preserve with corrupt claim");
    expect(await stat(path.join(files.statuses, "active-job.json"))).toBeDefined();
    expect((await stat(files.fence)).mode & 0o777).toBe(0o644);
    await expect(stat(corruptClaim)).rejects.toThrow();

    expect(files.runRecovery().status).not.toBe(0);
    expect(await readFile(quarantined, "utf8")).toBe("{not-json");
    expect(await files.commandSequence()).toEqual([]);
  });

  it("preserves a recoverable claim when terminated after fencing but before the active marker", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();
    await writeFile(path.join(files.statuses, "active-job.json"), JSON.stringify({
      schemaVersion: 1,
      jobId: RESTORE_JOB,
      createdAt: "2026-09-03T07:00:00Z",
    }));
    const child = spawn("sh", [worker], {
      cwd: projectDirectory,
      detached: true,
      env: { ...files.env, HOLD_FENCE_BARRIER: "true" },
      stdio: "ignore",
    });
    const childExit = new Promise<number | null>((resolve) => child.on("exit", resolve));

    await waitForFile(String(files.env.FENCE_HOLD_FILE));
    expect((await stat(files.fence)).mode & 0o777).toBe(0o644);
    if (child.pid === undefined) throw new Error("worker did not start");
    process.kill(-child.pid, "SIGTERM");
    expect(await childExit).not.toBe(0);

    const claim = path.join(files.rootOps, "claimed", `${RESTORE_JOB}.json`);
    expect((await stat(claim)).mode & 0o777).toBe(0o400);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "snapshotting" });
    expect(await stat(path.join(files.statuses, "active-job.json"))).toBeDefined();

    const failedRecovery = files.runWorker({ FAIL_STATUS_STATE: "failed" });

    expect(failedRecovery.status).not.toBe(0);
    expect((await stat(claim)).mode & 0o777).toBe(0o400);
    expect(await stat(path.join(files.statuses, "active-job.json"))).toBeDefined();
    expect((await stat(files.fence)).mode & 0o777).toBe(0o644);

    const recovery = files.runWorker();

    expect(recovery.status, recovery.stderr).toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "failed", code: "STALE_JOB" });
    await expect(stat(claim)).rejects.toThrow();
    await expect(stat(path.join(files.statuses, "active-job.json"))).rejects.toThrow();
    await expect(stat(files.fence)).rejects.toThrow();
    expect(await files.commandSequence()).toEqual([]);
  });

  it("preserves rollback evidence on TERM during destructive restore and intervenes on boot", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();
    const child = spawn("sh", [worker], {
      cwd: projectDirectory,
      detached: true,
      env: { ...files.env, HOLD_DESTRUCTIVE: "true" },
      stdio: "ignore",
    });
    const childExit = new Promise<number | null>((resolve) => child.on("exit", resolve));

    await waitForFile(String(files.env.DESTRUCTIVE_HOLD_FILE));
    if (child.pid === undefined) throw new Error("worker did not start");
    process.kill(-child.pid, "SIGTERM");
    expect(await childExit).not.toBe(0);

    const claim = path.join(files.rootOps, "claimed", `${RESTORE_JOB}.json`);
    expect((await stat(claim)).mode & 0o777).toBe(0o400);
    const workEntries = await readdir(path.join(files.rootOps, "work"));
    expect(workEntries).toHaveLength(1);
    await expect(stat(path.join(files.rootOps, "work", workEntries[0]!, "rollback.dump.enc"))).resolves.toBeDefined();
    expect(await files.rootMaintenance()).toMatchObject({ active: true, jobId: RESTORE_JOB });
    expect((await stat(files.fence)).mode & 0o777).toBe(0o644);

    const recovery = files.runWorker({ LOG_DURABILITY_BARRIERS: "true" });

    expect(recovery.status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({
      state: "intervention-required",
      code: "RESTORE_INTERRUPTED",
    });
    const intervention = path.join(files.rootOps, "intervention", RESTORE_JOB);
    expect((await readdir(intervention)).sort()).toEqual(["job.json", "rollback.dump.enc"]);
    expect((await stat(path.join(intervention, "rollback.dump.enc"))).mode & 0o777).toBe(0o400);
    expect((await files.commandSequence()).filter((entry) => entry === "reset-schema")).toHaveLength(1);
    expect(await files.commandSequence()).toEqual(expect.arrayContaining([
      "sync-intervention-cipher",
      "sync-intervention-job",
      "sync-intervention-dir",
    ]));
  });

  it("completes a terminal restore after power loss while clearing the authoritative marker", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();
    await writeFile(path.join(files.statuses, "active-job.json"), JSON.stringify({
      schemaVersion: 1,
      jobId: RESTORE_JOB,
      createdAt: "2026-09-03T07:00:00Z",
    }));
    const child = spawn("sh", [worker], {
      cwd: projectDirectory,
      detached: true,
      env: {
        ...files.env,
        HOLD_INACTIVE_MARKER_BARRIER: "true",
        LOG_DURABILITY_BARRIERS: "true",
      },
      stdio: "ignore",
    });
    const childExit = new Promise<number | null>((resolve) => child.on("exit", resolve));

    await waitForFile(String(files.env.INACTIVE_MARKER_HOLD_FILE));
    const terminalBeforeMarkerClear = path.join(files.rootOps, "completed", `${RESTORE_JOB}.json`);
    expect(await readJson(terminalBeforeMarkerClear))
      .toMatchObject({ id: RESTORE_JOB, type: "restore", state: "succeeded" });
    expect((await stat(terminalBeforeMarkerClear)).mode & 0o777).toBe(0o400);
    const beforeCrash = await files.commandSequence();
    expect(beforeCrash.lastIndexOf("sync-terminal")).toBeLessThan(beforeCrash.lastIndexOf("sync-marker"));
    expect(beforeCrash.lastIndexOf("sync-terminal-dir")).toBeLessThan(beforeCrash.lastIndexOf("sync-marker"));
    if (child.pid === undefined) throw new Error("worker did not start");
    process.kill(-child.pid, "SIGTERM");
    expect(await childExit).not.toBe(0);
    expect((await stat(files.fence)).mode & 0o777).toBe(0o644);

    const recovery = files.runRecovery();

    expect(recovery.status, recovery.stderr).toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "succeeded" });
    expect(await readJson(path.join(files.rootOps, "completed", `${RESTORE_JOB}.json`)))
      .toMatchObject({ id: RESTORE_JOB, type: "restore", state: "succeeded" });
    expect(await files.rootMaintenance()).toMatchObject({ active: false });
    expect(await files.maintenance()).toMatchObject({ active: false });
    await expect(stat(files.fence)).rejects.toThrow();
    await expect(stat(path.join(files.statuses, "active-job.json"))).rejects.toThrow();
    await expect(stat(path.join(files.rootOps, "claimed", `${RESTORE_JOB}.json`))).rejects.toThrow();
  });

  it("marks an interrupted in-maintenance restore for intervention instead of retrying it", async () => {
    const files = await workerFixture();
    const claimed = path.join(files.rootOps, "claimed");
    await mkdir(claimed);
    await chmod(claimed, 0o700);
    await writeFile(path.join(claimed, `${RESTORE_JOB}.json`), JSON.stringify({
      schemaVersion: 1,
      id: RESTORE_JOB,
      type: "restore",
      actorId: ADMIN,
      requestId: "01JINTERRUPTED",
      restoreId: INSPECT_JOB,
    }));
    await chmod(path.join(claimed, `${RESTORE_JOB}.json`), 0o400);
    await writeFile(path.join(files.rootOps, "maintenance.json"), JSON.stringify({
      schemaVersion: 1,
      active: true,
      jobId: RESTORE_JOB,
      updatedAt: "2026-09-03T00:00:00Z",
    }));
    await chmod(path.join(files.rootOps, "maintenance.json"), 0o600);
    await writeFile(path.join(files.statuses, "maintenance.json"), JSON.stringify({
      schemaVersion: 1,
      active: false,
      updatedAt: "2026-09-03T00:00:00Z",
    }));

    const result = files.runWorker();

    expect(result.status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "intervention-required", code: "RESTORE_INTERRUPTED" });
    expect(await files.maintenance()).toMatchObject({ active: true, jobId: RESTORE_JOB });
    expect(await files.rootMaintenance()).toMatchObject({ active: true, jobId: RESTORE_JOB });
    expect(await files.commandSequence()).toEqual([]);
    const intervention = path.join(files.rootOps, "intervention", RESTORE_JOB);
    expect(await readdir(intervention)).toEqual(["job.json"]);
    expect((await stat(intervention)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(intervention, "job.json"))).mode & 0o777).toBe(0o400);
  });

  it.each([
    ["active", JSON.stringify({
      schemaVersion: 1,
      active: true,
      jobId: RESTORE_JOB,
      updatedAt: "2026-09-03T00:00:00Z",
    })],
    ["corrupt", "{not-valid-json"],
  ])("recreates the external fence and blocks boot for an %s root marker", async (_caseName, marker) => {
    const files = await workerFixture();
    await writeFile(path.join(files.rootOps, "maintenance.json"), marker);
    await chmod(path.join(files.rootOps, "maintenance.json"), 0o600);

    const result = files.runWorker();

    expect(result.status).not.toBe(0);
    expect((await stat(files.fence)).mode & 0o777).toBe(0o644);
    expect((await stat(path.dirname(files.fence))).mode & 0o777).toBe(0o755);
    expect(await files.commandSequence()).toEqual([]);
  });

  it("redacts rejected values from audit while preserving corrupt-claim evidence", async () => {
    const files = await workerFixture();
    const leakedPath = "/tmp/private-upload-name.fitgridbackup";
    const secret = "portable password must never be logged";
    await writeFile(path.join(files.inbox, `${JOB_A}.json`), JSON.stringify({
      schemaVersion: 1,
      id: JOB_A,
      type: "backup",
      actorId: ADMIN,
      requestId: "01JSECRET",
      uploadPath: leakedPath,
      password: secret,
    }));
    await writeFile(path.join(files.inbox, `${JOB_A}.secret`), secret);
    await writeFile(path.join(files.uploads, `${JOB_A}.fitgridbackup`), "untrusted upload bytes");

    files.runWorker();

    const audit = await readFile(files.audit, "utf8");
    expect(audit).toContain('"code":"INVALID_JOB"');
    expect(audit).not.toContain(leakedPath);
    expect(audit).not.toContain(secret);
    expect(audit).not.toContain("postgresql://");
    expect(await readdir(files.inbox)).toEqual([`${JOB_A}.secret`]);
    expect(await readdir(files.uploads)).toEqual([`${JOB_A}.fitgridbackup`]);
    expect((await stat(path.join(files.rootOps, "intervention", "corrupt-claims", `${JOB_A}.json`))).mode & 0o777)
      .toBe(0o400);
  });

  it("purges secret and upload orphans that arrive after a missing-secret job terminates", async () => {
    const files = await workerFixture();
    await files.enqueue({ schemaVersion: 1, id: JOB_A, type: "backup", actorId: ADMIN, requestId: "01JLATE" });
    expect(files.runWorker().status).not.toBe(0);
    expect(await files.status(JOB_A)).toMatchObject({ state: "failed", code: "MISSING_SECRET" });

    await writeFile(path.join(files.inbox, `${JOB_A}.secret`), "late secret");
    await writeFile(path.join(files.uploads, `${JOB_A}.fitgridbackup`), "late upload");
    const sweep = files.runWorker();

    expect(sweep.status).toBe(0);
    expect(await readdir(files.inbox)).toEqual([]);
    expect(await readdir(files.uploads)).toEqual([]);
  });
});
