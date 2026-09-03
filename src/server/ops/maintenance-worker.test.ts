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

const projectDirectory = process.cwd();
const worker = path.join(projectDirectory, "ops/maintenance-worker.sh");
const ADMIN = "846b92e7-0f27-4d5e-96e2-429c120e2324";
const JOB_A = "978dbffd-3667-4b37-826b-956f0c63938a";
const JOB_B = "79fc98ea-46a7-40b7-9bb3-e25f2f4ce52d";
const INSPECT_JOB = "ef4faf98-dc68-409c-b630-5dfbc173c99e";
const RESTORE_JOB = "cba6002b-19c5-4753-a511-ed06c4709036";

type WorkerOptions = {
  restoredHealth?: boolean;
  rollbackHealth?: boolean;
  failRollbackQuiesce?: boolean;
};

async function executable(directory: string, name: string, source: string) {
  const file = path.join(directory, name);
  await writeFile(file, `#!/bin/sh\nset -eu\n${source}\n`);
  await chmod(file, 0o700);
}

async function readJson(file: string) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function createPortableArchive(root: string) {
  const payload = path.join(root, "portable-payload");
  await mkdir(payload);
  const dump = "verified portable custom dump";
  await writeFile(path.join(payload, "database.dump"), dump);
  await writeFile(
    path.join(payload, "database.dump.sha256"),
    `${createHash("sha256").update(dump).digest("hex")}  database.dump\n`,
  );
  await writeFile(
    path.join(payload, "manifest.json"),
    JSON.stringify({
      format: "fitgridweb-portable-backup",
      formatVersion: "1.0.0",
      createdAt: "2026-09-03T07:00:00Z",
      appImage: "ghcr.io/example/fitgridweb:sha-2ca7f41",
      postgresMajor: 17,
      database: "fitgridweb",
      counts: { users: 2, gridTrades: 24, invitations: 1, importPreviews: 0 },
    }),
  );
  const archive = path.join(root, "upload.fitgridbackup");
  const result = spawnSync(
    "tar",
    ["-cf", archive, "manifest.json", "database.dump", "database.dump.sha256"],
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
  const audit = path.join(rootOps, "audit.jsonl");
  const activeCount = path.join(root, "active-count");
  const maxActive = path.join(root, "max-active");
  const backupKey = path.join(root, "backup.key");
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
lock="$FAKE_ACTIVITY_LOCK"
while ! mkdir "$lock" 2>/dev/null; do sleep 0.01; done
active=$(cat "$FAKE_ACTIVE_COUNT")
active=$((active + 1))
printf '%s\n' "$active" >"$FAKE_ACTIVE_COUNT"
maximum=$(cat "$FAKE_MAX_ACTIVE")
[ "$active" -le "$maximum" ] || printf '%s\n' "$active" >"$FAKE_MAX_ACTIVE"
rmdir "$lock"
finish() {
  while ! mkdir "$lock" 2>/dev/null; do sleep 0.01; done
  active=$(cat "$FAKE_ACTIVE_COUNT")
  printf '%s\n' "$((active - 1))" >"$FAKE_ACTIVE_COUNT"
  rmdir "$lock"
}
trap finish EXIT HUP INT TERM
sleep "\${FAKE_DOCKER_DELAY:-0}"
case "$*" in
  *"pg_database_size"*) printf '1024\n' ;;
  *"server_version_num"*) printf '170006\n' ;;
  *"COUNT(*)"*) printf '2|24|1|0\n' ;;
  *"pg_dump"*)
    if [ "\${MAINTENANCE_OPERATION:-}" = restore ]; then
      printf 'rollback-snapshot\n' >>"$COMMAND_LOG"
      printf 'rollback custom dump'
    else
      printf 'portable custom dump'
    fi ;;
  *"pg_restore --list"*) cat >/dev/null ;;
  *" stop app"*)
    printf 'stop-app\n' >>"$COMMAND_LOG"
    if [ "\${MAINTENANCE_RESTORE_SOURCE:-}" = rollback ] && [ "$FAIL_ROLLBACK_QUIESCE" = true ]; then exit 9; fi ;;
  *"pg_terminate_backend"*) printf 'terminate-app-connections\n' >>"$COMMAND_LOG" ;;
  *"pg_restore --clean"*)
    restored_payload=$(cat)
    if [ "\${MAINTENANCE_RESTORE_SOURCE:-}" = upload ] && [ -n "$EXPECTED_UPLOAD_CONTENT" ] \
      && [ "$restored_payload" != "$EXPECTED_UPLOAD_CONTENT" ]; then exit 17; fi
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
case "\${MAINTENANCE_HEALTH_PHASE:-}" in
  restored)
    if [ "$RESTORED_HEALTH" != true ]; then
      printf 'health-failed\n' >>"$COMMAND_LOG"
      exit 22
    fi ;;
  rollback)
    if [ "$ROLLBACK_HEALTH" != true ]; then
      printf 'health-failed\n' >>"$COMMAND_LOG"
      exit 22
    fi ;;
esac
case "$*" in *"https://"*) printf 'health-ok\n' >>"$COMMAND_LOG" ;; esac`,
  );
  await executable(bin, "age", "cat");
  await executable(
    bin,
    "stat",
    `
if [ "$1" = -c ] && [ "$2" = %u ]; then printf '%s\n' "$FAKE_ROOT_OWNER"; exit 0; fi
if [ "$1" = -f ] && [ "$2" = %u ]; then printf '%s\n' "$FAKE_ROOT_OWNER"; exit 0; fi
exec /usr/bin/stat "$@"`,
  );
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
    `exec /usr/bin/python3 -c 'import fcntl,sys;\ntry: fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(1)'`,
  );
  await executable(
    bin,
    "mv",
    `
source=$1
destination=$2
if [ "$destination" = "$STATUS_DIRECTORY/maintenance.json" ] \
  && [ "$FAIL_MARKER_CLEAR" = true ] \
  && /usr/bin/jq -e '.active == false' "$source" >/dev/null \
  && [ ! -f "$FAIL_MARKER_FILE" ]; then
  : >"$FAIL_MARKER_FILE"
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
      */maintenance.json) : ;;
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
    FAIL_ROLLBACK_QUIESCE: String(options.failRollbackQuiesce ?? false),
    EXPECTED_UPLOAD_CONTENT: "",
    FAKE_ROOT_OWNER: "0",
    RACE_PREPARED_REPLACEMENT: "false",
    LN_LOG: path.join(root, "ln.log"),
    FAIL_MARKER_CLEAR: "false",
    FAIL_MARKER_FILE: path.join(root, "fail-marker-once"),
    FAIL_STATUS_STATE: "",
    FAIL_STATUS_FILE: path.join(root, "fail-status-once"),
    FAIL_COMPLETED_LEDGER: "false",
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

  async function enqueueInspect(id = INSPECT_JOB) {
    const archive = await createPortableArchive(root);
    await writeFile(path.join(uploads, `${id}.fitgridbackup`), await readFile(archive));
    await chmod(path.join(uploads, `${id}.fitgridbackup`), 0o600);
    await enqueue(
      { schemaVersion: 1, id, type: "inspect-restore", actorId: ADMIN, requestId: "01JUPLOAD" },
      "portable password",
    );
  }

  async function prepareRestore(overrides: { expiresAt?: number; dump?: string } = {}) {
    const directory = path.join(prepared, INSPECT_JOB);
    await mkdir(directory);
    const dump = overrides.dump ?? "verified prepared custom dump";
    await writeFile(path.join(directory, "database.dump"), dump);
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        format: "fitgridweb-portable-backup",
        formatVersion: "1.0.0",
        createdAt: "2026-09-03T07:00:00Z",
        appImage: "ghcr.io/example/fitgridweb:sha-2ca7f41",
        postgresMajor: 17,
        database: "fitgridweb",
        counts: { users: 2, gridTrades: 24, invitations: 1, importPreviews: 0 },
      }),
    );
    await writeFile(
      path.join(directory, "challenge.json"),
      JSON.stringify({
        schemaVersion: 1,
        jobId: INSPECT_JOB,
        actorId: ADMIN,
        requestId: "01JUPLOAD",
        dumpSha256: createHash("sha256").update(dump).digest("hex"),
        expiresAt: overrides.expiresAt ?? 1788423000,
      }),
    );
    await Promise.all([
      chmod(path.join(directory, "database.dump"), 0o400),
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
    audit,
    maxActive,
    env,
    enqueue,
    enqueueInspect,
    prepareRestore,
    enqueueRestore,
    runWorker,
    status: (id: string) => readJson(path.join(statuses, `${id}.json`)),
    transitions: async (id: string) => (await readFile(path.join(transitionsDirectory, `${id}.json`), "utf8")).trim().split("\n"),
    commandSequence: async () => (await readFile(commandLog, "utf8")).trim().split("\n").filter(Boolean),
    maintenance: () => readJson(path.join(statuses, "maintenance.json")),
    rootMaintenance: () => readJson(path.join(rootOps, "maintenance.json")),
  };
}

describe("host maintenance worker", { timeout: 15_000 }, () => {
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
      preview: { users: 2, gridTrades: 24, invitations: 1, importPreviews: 0 },
    });
    const preparedDirectory = path.join(files.prepared, INSPECT_JOB);
    expect((await stat(path.join(preparedDirectory, "database.dump"))).mode & 0o777).toBe(0o400);
    expect((await stat(path.join(preparedDirectory, "manifest.json"))).mode & 0o777).toBe(0o400);
    expect((await stat(path.join(preparedDirectory, "challenge.json"))).mode & 0o777).toBe(0o400);
    expect((await stat(preparedDirectory)).mode & 0o777).toBe(0o500);
    expect(await readdir(files.uploads)).toEqual([]);
    expect(await readdir(files.inbox)).toEqual([]);
  });

  it.each([
    ["group-writable root state", async (files: Awaited<ReturnType<typeof workerFixture>>) => chmod(files.rootOps, 0o770), {}],
    ["group-writable claimed state", async (files: Awaited<ReturnType<typeof workerFixture>>) => {
      const claimed = path.join(files.rootOps, "claimed");
      await mkdir(claimed);
      await chmod(claimed, 0o770);
    }, {}],
    ["non-root-owned root state", async () => undefined, { FAKE_ROOT_OWNER: "501" }],
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
      EXPECTED_UPLOAD_CONTENT: "verified prepared custom dump",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "succeeded" });
    expect(await readFile(path.join(files.root, "ln.log"), "utf8")).toBe("claim\n");
  });

  it("rolls production back exactly once when restored application health fails", async () => {
    const files = await workerFixture({ restoredHealth: false, rollbackHealth: true });
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker();

    expect(result.status, result.stderr).toBe(0);
    expect(await files.commandSequence()).toEqual([
      "rollback-snapshot",
      "stop-app",
      "terminate-app-connections",
      "restore-upload",
      "migrate",
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

  it("leaves maintenance active when restore and rollback both fail", async () => {
    const files = await workerFixture({ restoredHealth: false, rollbackHealth: false });
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker();

    expect(result.status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({
      state: "intervention-required",
      rolledBack: false,
      code: "ROLLBACK_FAILED",
    });
    expect(await files.maintenance()).toMatchObject({ active: true, jobId: RESTORE_JOB });
    expect((await files.commandSequence()).filter((entry) => entry === "restore-rollback")).toHaveLength(1);
    await expect(stat(path.join(files.prepared, INSPECT_JOB))).rejects.toThrow();
    const intervention = path.join(files.rootOps, "intervention", RESTORE_JOB);
    expect((await readdir(intervention)).sort()).toEqual(["job.json", "rollback.dump.enc"]);
    expect((await stat(intervention)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(intervention, "rollback.dump.enc"))).mode & 0o777).toBe(0o400);
    expect(await readFile(path.join(intervention, "rollback.dump.enc"), "utf8")).toBe("rollback custom dump");

    expect(files.runWorker().status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "intervention-required", code: "ROLLBACK_FAILED" });
    expect((await files.commandSequence()).filter((entry) => entry === "restore-rollback")).toHaveLength(1);
  });

  it("does not write rollback data when rollback quiescing fails", async () => {
    const files = await workerFixture({ restoredHealth: false, failRollbackQuiesce: true });
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker();

    expect(result.status).not.toBe(0);
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "intervention-required", code: "ROLLBACK_FAILED" });
    expect(await files.commandSequence()).toEqual([
      "rollback-snapshot",
      "stop-app",
      "terminate-app-connections",
      "restore-upload",
      "migrate",
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

  it("reasserts maintenance when terminal success status publication fails", async () => {
    const files = await workerFixture();
    await files.prepareRestore();
    await files.enqueueRestore();

    const result = files.runWorker({ FAIL_STATUS_STATE: "succeeded" });

    expect(result.status).not.toBe(0);
    expect(await files.maintenance()).toMatchObject({ active: true, jobId: RESTORE_JOB });
    expect(await files.status(RESTORE_JOB)).toMatchObject({ state: "intervention-required", code: "STATUS_PUBLISH_FAILED" });
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

    const commandsBeforeReboot = await files.commandSequence();
    expect(files.runWorker().status).not.toBe(0);
    expect(await files.commandSequence()).toEqual(commandsBeforeReboot);
  });

  it("removes prepared plaintext and passwords when the completed ledger cannot publish after inspection", async () => {
    const files = await workerFixture();
    await files.enqueueInspect();

    const result = files.runWorker({ FAIL_COMPLETED_LEDGER: "true" });

    expect(result.status).not.toBe(0);
    expect(await files.status(INSPECT_JOB)).toMatchObject({
      state: "intervention-required",
      code: "TERMINAL_STATE_WRITE_FAILED",
    });
    expect(await files.rootMaintenance()).toMatchObject({ schemaVersion: 1, active: true, jobId: INSPECT_JOB });
    expect(await readdir(path.join(files.rootOps, "intervention", INSPECT_JOB))).toEqual(["job.json"]);
    await expect(stat(path.join(files.prepared, INSPECT_JOB))).rejects.toThrow();
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

  it("rejects a replaced prepared dump before snapshotting or stopping the app", async () => {
    const files = await workerFixture();
    const directory = await files.prepareRestore();
    await chmod(directory, 0o700);
    await chmod(path.join(directory, "database.dump"), 0o600);
    await writeFile(path.join(directory, "database.dump"), "attacker replacement");
    await chmod(path.join(directory, "database.dump"), 0o400);
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
    await writeFile(path.join(claimed, `${JOB_A}.secret`), "do not retain me");
    await writeFile(path.join(files.inbox, `${JOB_A}.secret`), "nor me");

    const result = files.runWorker();

    expect(result.status).not.toBe(0);
    expect(await files.status(JOB_A)).toMatchObject({ state: "failed", code: "STALE_JOB" });
    expect(await readdir(claimed)).toEqual([]);
    expect(await readdir(files.inbox)).toEqual([]);
    expect(await files.commandSequence()).toEqual([]);
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

  it("redacts rejected task values, secrets, database URLs, and command output from audit", async () => {
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
    expect(await readdir(files.inbox)).toEqual([]);
    expect(await readdir(files.uploads)).toEqual([]);
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
