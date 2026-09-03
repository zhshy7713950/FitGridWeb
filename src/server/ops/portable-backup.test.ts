import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const projectDirectory = process.cwd();

type PortableFixtureOptions = {
  ageExit?: number;
  availableKilobytes?: number;
  databaseBytes?: number;
  existingBackups?: number;
  exportUserRow?: string;
  maxBytes?: number;
  publishChownExit?: number;
  publishChmodExit?: number;
  psqlExit?: number;
  syncExit?: number;
};

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

async function executable(directory: string, name: string, source: string) {
  const file = path.join(directory, name);
  await writeFile(file, `#!/bin/sh\nset -eu\n${source}\n`);
  await chmod(file, 0o700);
}

async function recursiveNames(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = await Promise.all(entries.map(async (entry) => {
    const name = path.join(prefix, entry.name);
    return entry.isDirectory() ? recursiveNames(path.join(directory, entry.name), name) : [name];
  }));
  return names.flat().sort();
}

async function successfulPortableNames(directory: string) {
  return (await recursiveNames(directory)).filter((name) => name.endsWith(".fitgridbackup")).sort().reverse();
}

async function readJson(file: string) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function createTar(root: string, name: string, manifest: string, dump = "valid custom dump") {
  const payload = path.join(root, `${name}-payload`);
  await mkdir(payload);
  await writeFile(path.join(payload, "manifest.json"), manifest);
  await writeFile(path.join(payload, "database.dump"), dump);
  const checksum = spawnSync("shasum", ["-a", "256", "database.dump"], { cwd: payload, encoding: "utf8" });
  if (checksum.status !== 0) throw new Error(checksum.stderr);
  await writeFile(path.join(payload, "database.dump.sha256"), checksum.stdout.replace(/^([a-f0-9]+)  /, "$1  "));
  const archive = path.join(root, name);
  const tar = spawnSync("tar", ["-cf", archive, "manifest.json", "database.dump", "database.dump.sha256"], { cwd: payload, encoding: "utf8" });
  if (tar.status !== 0) throw new Error(tar.stderr);
  return archive;
}

async function createCanonicalTar(
  root: string,
  name: string,
  manifest: string,
  overrides: Partial<Record<(typeof canonicalCsvFiles)[number], string>> = {},
) {
  const payload = path.join(root, `${name}-payload`);
  await mkdir(payload);
  await writeFile(path.join(payload, "manifest.json"), manifest);
  for (const file of canonicalCsvFiles) {
    await writeFile(path.join(payload, file), overrides[file] ?? "");
  }
  const checksums = canonicalCsvFiles.map((file) => {
    const contents = overrides[file] ?? "";
    return `${createHash("sha256").update(contents).digest("hex")}  ${file}`;
  }).join("\n") + "\n";
  await writeFile(path.join(payload, "payload.sha256"), checksums);
  const archive = path.join(root, name);
  const tar = spawnSync(
    "tar",
    ["-cf", archive, ...canonicalCsvFiles, "manifest.json", "payload.sha256"],
    { cwd: payload, encoding: "utf8" },
  );
  if (tar.status !== 0) throw new Error(tar.stderr);
  return archive;
}

async function portableFixture(options: PortableFixtureOptions = {}) {
  const root = path.join(tmpdir(), `fitgrid-portable-${randomUUID()}`);
  const bin = path.join(root, "bin");
  const backups = path.join(root, "backups");
  const prepared = path.join(root, "prepared");
  const environmentFile = path.join(root, ".env");
  const passphrase = path.join(root, "passphrase");
  const history = path.join(root, "history.json");
  const statusFile = path.join(root, "status.json");
  const commandLog = path.join(root, "commands.log");
  await mkdir(bin, { recursive: true });
  await mkdir(backups);
  await mkdir(prepared);
  await writeFile(passphrase, "correct horse battery");
  await chmod(passphrase, 0o600);
  await writeFile(environmentFile, [
    "DOMAIN=grid.example.com",
    "APP_IMAGE=ghcr.io/example/fitgridweb:sha-2ca7f41",
    "POSTGRES_DB=fitgridweb",
    "POSTGRES_USER=fitgrid_migrate",
    "POSTGRES_PASSWORD=database-secret-at-least-thirty-two-characters",
    "APP_DATABASE_USER=fitgrid_app",
    "APP_DATABASE_PASSWORD=runtime-secret-at-least-thirty-two-characters",
    "DATABASE_URL=postgresql://fitgrid_app:secret@db:5432/fitgridweb",
    "MIGRATION_DATABASE_URL=postgresql://fitgrid_migrate:secret@db:5432/fitgridweb",
    "BETTER_AUTH_SECRET=auth-secret-at-least-thirty-two-characters",
    "OWNER_REF_SECRET=owner-secret-at-least-thirty-two-characters",
    `PORTABLE_BACKUP_DIR=${backups}`,
    `PORTABLE_BACKUP_HISTORY_FILE=${history}`,
    `PORTABLE_BACKUP_MAX_BYTES=${options.maxBytes ?? 536870912}`,
  ].join("\n"));
  await chmod(environmentFile, 0o600);
  await writeFile(history, JSON.stringify({ entries: [] }));

  const existingTimestamps = ["20260902", "20260901", "20260831", "20260830", "20260829"];
  for (const timestamp of existingTimestamps.slice(0, options.existingBackups ?? 0)) {
    await writeFile(path.join(backups, `fitgridweb-${timestamp}T070000Z.fitgridbackup`), timestamp);
  }

  await executable(bin, "docker", `
printf 'docker %s\\n' "$*" >>"$COMMAND_LOG"
case "$*" in
  *"psql --no-psqlrc --quiet"*)
    portable_export_sql=$(cat)
    printf '%s\n' "$portable_export_sql" >>"$COMMAND_LOG"
    printf '%s\n' \
      '__FITGRID_PORTABLE_V3_ACCOUNTS__' '"e30="' \
      '__FITGRID_PORTABLE_V3_GRID_TRADES__' '"e30="' \
      '__FITGRID_PORTABLE_V3_IMPORT_PREVIEWS__' '"e30="' \
      '__FITGRID_PORTABLE_V3_INVITATIONS__' '"e30="' \
      '__FITGRID_PORTABLE_V3_SESSIONS__' '"e30="' \
      '__FITGRID_PORTABLE_V3_USERS__'
    printf '%s\n' "\${EXPORT_USER_ROW:-\"e30=\"}"
    printf '%s\n' \
      '__FITGRID_PORTABLE_V3_VERIFICATIONS__' '"e30="' \
      '__FITGRID_PORTABLE_V3_END__'
    [ "\${PSQL_EXIT:-0}" = 0 ] || exit "$PSQL_EXIT" ;;
  *"pg_dump"*) printf 'valid custom dump' ;;
  *"pg_restore --list"*)
    portable_fake_dump=$(cat)
    case "$portable_fake_dump" in
      *"unsafe function"*) printf '31; 1255 9001 FUNCTION public steal() fitgrid_migrate\\n' ;;
      *"unsafe acl"*) printf '32; 0 0 ACL public TABLE users fitgrid_migrate\\n' ;;
      *"unsafe pre-data"*) printf '33; 1259 9002 TABLE public attacker fitgrid_migrate\\n' ;;
      *"unsafe prisma migrations"*) printf '34; 0 9003 TABLE DATA public _prisma_migrations fitgrid_migrate\\n' ;;
      *"unsafe post-data"*) printf '35; 2606 9004 FK CONSTRAINT public accounts accounts_user_id_fkey fitgrid_migrate\\n' ;;
      *"unsafe ddl"*) printf '36; 1259 9005 INDEX public users_email_key fitgrid_migrate\\n' ;;
      *"valid sequence"*)
        printf '37; 0 9006 TABLE DATA public users fitgrid_migrate\\n'
        printf '38; 0 9007 SEQUENCE SET public safe_sequence fitgrid_migrate\\n' ;;
      *) printf '39; 0 9008 TABLE DATA public users fitgrid_migrate\\n' ;;
    esac ;;
  *"pg_database_size"*) printf '%s\\n' "$DATABASE_BYTES" ;;
  *"server_version_num"*) printf '170006\\n' ;;
  *"COUNT(*)"*) printf '2|24|1|0\\n' ;;
esac`);
  await executable(bin, "age", `
printf 'age %s\\n' "$*" >>"$COMMAND_LOG"
[ "\${AGE_EXIT:-0}" = 0 ] || exit "$AGE_EXIT"
[ -z "\${AGE_PASSPHRASE:-}" ] || { printf 'AGE_PASSPHRASE must not be exported\\n' >&2; exit 90; }
case "$*" in
  "-e -j batchpass"|"-d -j batchpass") : ;;
  *"-p"*) printf 'interactive passphrase mode is forbidden\\n' >&2; exit 91 ;;
  *) printf 'batchpass plugin was not selected\\n' >&2; exit 92 ;;
esac
case "\${AGE_PASSPHRASE_FD:-}" in ''|*[!0-9]*) printf 'passphrase fd is missing\\n' >&2; exit 93 ;; esac
eval 'portable_fake_secret=$(cat <&'"$AGE_PASSPHRASE_FD"')'
[ -n "$portable_fake_secret" ] || { printf 'passphrase fd is unreadable\\n' >&2; exit 94; }
portable_fake_secret=
cat`);
  await executable(bin, "chown", `
printf 'chown %s\\n' "$*" >>"$COMMAND_LOG"
[ "\${PUBLISH_CHOWN_EXIT:-0}" = 0 ] || exit "$PUBLISH_CHOWN_EXIT"`);
  await executable(bin, "chmod", `
printf 'chmod %s\\n' "$*" >>"$COMMAND_LOG"
case "$1" in
  640|0640) case "$2" in *fitgridbackup*) [ "\${PUBLISH_CHMOD_EXIT:-0}" = 0 ] || exit "$PUBLISH_CHMOD_EXIT" ;; esac ;;
esac
exec /bin/chmod "$@"`);
  await executable(bin, "stat", `
case "$1" in
  -c) case "$2" in
    %a) printf '600\\n' ;;
    %s) printf '321\\n' ;;
  esac ;;
  -f) case "$2" in
    %Lp) printf '600\\n' ;;
    %z) printf '321\\n' ;;
  esac ;;
esac`);
  await executable(bin, "id", "printf '0\\n'");
  await executable(bin, "df", `
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
printf 'fitgrid 999999999 0 %s 0%% /\\n' "$AVAILABLE_KILOBYTES"`);
  await executable(bin, "sync", `
printf 'sync %s\\n' "$*" >>"$COMMAND_LOG"
[ -z "\${SYNC_FAIL_TARGET:-}" ] || [ "\${2:-}" != "$SYNC_FAIL_TARGET" ] || exit 73
[ "\${SYNC_EXIT:-0}" = 0 ] || exit "$SYNC_EXIT"`);

  return {
    root, bin, backups, prepared, environmentFile, passphrase, history, statusFile, commandLog,
    ageExit: options.ageExit ?? 0,
    availableKilobytes: options.availableKilobytes ?? 10 * 1024 * 1024,
    databaseBytes: options.databaseBytes ?? 1024,
    exportUserRow: options.exportUserRow ?? '"e30="',
    publishChownExit: options.publishChownExit ?? 0,
    publishChmodExit: options.publishChmodExit ?? 0,
    psqlExit: options.psqlExit ?? 0,
    syncExit: options.syncExit ?? 0,
  };
}

function testEnvironment(files: Awaited<ReturnType<typeof portableFixture>>, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    PATH: `${files.bin}:${process.env.PATH}`,
    ENV_FILE: files.environmentFile,
    COMMAND_LOG: files.commandLog,
    AGE_EXIT: String(files.ageExit),
    AVAILABLE_KILOBYTES: String(files.availableKilobytes),
    DATABASE_BYTES: String(files.databaseBytes),
    EXPORT_USER_ROW: files.exportUserRow,
    PUBLISH_CHOWN_EXIT: String(files.publishChownExit),
    PUBLISH_CHMOD_EXIT: String(files.publishChmodExit),
    PSQL_EXIT: String(files.psqlExit),
    SYNC_EXIT: String(files.syncExit),
    FITGRID_BACKUP_TIMESTAMP: "20260903T070000Z",
    TMPDIR: files.root,
    ...extra,
  };
}

function runPortableCreate(
  files: Awaited<ReturnType<typeof portableFixture>>,
  extra: Record<string, string> = {},
) {
  return spawnSync("sh", ["-c", `. \"${path.join(projectDirectory, "ops/lib/portable-backup.sh")}\"; . \"${path.join(projectDirectory, "ops/env.sh")}\"; load_fitgrid_environment; create_portable_backup \"$PASSPHRASE_FILE\" \"$PORTABLE_BACKUP_DIR\" \"$PORTABLE_BACKUP_HISTORY_FILE\" \"$STATUS_FILE\"`], {
    cwd: projectDirectory,
    encoding: "utf8",
    env: testEnvironment(files, { PASSPHRASE_FILE: files.passphrase, STATUS_FILE: files.statusFile, ...extra }),
  });
}

function runPortablePrune(files: Awaited<ReturnType<typeof portableFixture>>) {
  return spawnSync("sh", ["-c", `. "${path.join(projectDirectory, "ops/lib/portable-backup.sh")}"; prune_portable_backups "$BACKUPS" "$HISTORY" 5`], {
    cwd: projectDirectory,
    encoding: "utf8",
    env: testEnvironment(files, { BACKUPS: files.backups, HISTORY: files.history }),
  });
}

function runPortableInspect(files: Awaited<ReturnType<typeof portableFixture>>, archive: string, resultFile = path.join(files.root, "result.json")) {
  return spawnSync("sh", ["-c", `. \"${path.join(projectDirectory, "ops/lib/portable-backup.sh")}\"; . \"${path.join(projectDirectory, "ops/env.sh")}\"; load_fitgrid_environment; inspect_portable_backup \"$ARCHIVE\" \"$PASSPHRASE_FILE\" \"$PREPARED_DIRECTORY\" \"$RESULT_FILE\"`], {
    cwd: projectDirectory,
    encoding: "utf8",
    env: testEnvironment(files, {
      ARCHIVE: archive,
      PASSPHRASE_FILE: files.passphrase,
      PREPARED_DIRECTORY: files.prepared,
      RESULT_FILE: resultFile,
    }),
  });
}

function runCanonicalRestoreWithEmitterFailure(files: Awaited<ReturnType<typeof portableFixture>>) {
  return spawnSync("sh", ["-c", `. "${path.join(projectDirectory, "ops/lib/portable-backup.sh")}"; . "${path.join(projectDirectory, "ops/env.sh")}"; load_fitgrid_environment; portable_emit_restore_sql() { return 37; }; portable_restore_canonical_data "$PREPARED_DIRECTORY"`], {
    cwd: projectDirectory,
    encoding: "utf8",
    env: testEnvironment(files, { PREPARED_DIRECTORY: files.prepared }),
  });
}

async function portableInspectFixture(caseName: string) {
  const files = await portableFixture();
  const manifestValue: Record<string, unknown> = {
    format: "fitgridweb-portable-backup",
    formatVersion: caseName === "unknown format" ? "9.0.0" : caseName === "legacy full format" ? "1.0.0" : "3.0.0",
    dumpMode: "canonical-csv",
    dataEncoding: "base64-json-row-v1",
    createdAt: "2026-09-03T07:00:00Z",
    appImage: "ghcr.io/example/fitgridweb:sha-2ca7f41",
    postgresMajor: 17,
    database: "fitgridweb",
    counts: { users: caseName === "count mismatch" ? 2 : 1, gridTrades: 0, invitations: 0, importPreviews: 0 },
  };
  if (caseName === "extra manifest field") manifestValue.command = "DROP TABLE users";
  const manifest = JSON.stringify(manifestValue);
  const archive = await createCanonicalTar(
    files.root,
    "upload.fitgridbackup",
    manifest,
    { "users.csv": canonicalCsvRow({ id: "user-1", value: "valid canonical row" }) },
  );
  if (caseName === "tampered archive") {
    const payload = path.join(files.root, "upload.fitgridbackup-payload", "users.csv");
    await writeFile(payload, canonicalCsvRow({ id: "tampered" }));
    const tar = spawnSync(
      "tar",
      ["-cf", archive, ...canonicalCsvFiles, "manifest.json", "payload.sha256"],
      { cwd: path.dirname(payload), encoding: "utf8" },
    );
    if (tar.status !== 0) throw new Error(tar.stderr);
  }
  if (caseName === "wrong password") files.ageExit = 1;
  if (caseName === "hostile checksum filename" || caseName === "multiple checksum records") {
    const checksum = caseName === "hostile checksum filename"
      ? "0000000000000000000000000000000000000000000000000000000000000000  /etc/passwd\\n"
      : "0000000000000000000000000000000000000000000000000000000000000000  users.csv\\n0000000000000000000000000000000000000000000000000000000000000000  /etc/passwd\\n";
    const payload = path.join(files.root, "upload.fitgridbackup-payload", "payload.sha256");
    await writeFile(payload, checksum);
    const tar = spawnSync(
      "tar",
      ["-cf", archive, ...canonicalCsvFiles, "manifest.json", "payload.sha256"],
      { cwd: path.dirname(payload), encoding: "utf8" },
    );
    if (tar.status !== 0) throw new Error(tar.stderr);
    await executable(files.bin, "sha256sum", `
if [ "$1" = -c ]; then
  printf 'sha256sum -c %s\\n' "$2" >>"$COMMAND_LOG"
  exit 0
fi
exec /sbin/sha256sum "$@"`);
  }
  if (caseName === "../escape") {
    await executable(files.bin, "tar", `
case "$1" in
  -tf) printf '../escape\\n' ;;
  *) exec /usr/bin/tar "$@" ;;
esac`);
  }
  if (caseName === "tar extraction failure") {
    await executable(files.bin, "tar", `
case "$1" in
  -xOf) /usr/bin/tar "$@"; exit 66 ;;
  *) exec /usr/bin/tar "$@" ;;
esac`);
  }
  return { ...files, archive };
}

describe("portable backups", () => {
  it("reserves peak creation space from the configured payload limit rather than database estimates", async () => {
    const files = await portableFixture({
      databaseBytes: 1,
      maxBytes: 100 * 1024 * 1024,
      availableKilobytes: 600 * 1024,
    });

    const result = runPortableCreate(files);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Insufficient free space");
    await expect(readFile(files.commandLog, "utf8")).rejects.toThrow();
  });

  it("creates a v3 canonical per-table payload without pg_dump or pg_restore", async () => {
    const files = await portableFixture();
    const result = runPortableCreate(files);
    expect(result.status, result.stderr).toBe(0);

    const commandLog = await readFile(files.commandLog, "utf8");
    expect(commandLog).not.toContain("pg_dump");
    expect(commandLog).not.toContain("pg_restore");
    expect(commandLog).toContain("COPY (");
    expect(commandLog).toContain("jsonb_build_object");
    expect(commandLog).toContain("ORDER BY id");
    const archive = path.join(files.backups, "fitgridweb-20260903T070000Z.fitgridbackup");
    const manifest = spawnSync("tar", ["-xOf", archive, "manifest.json"], { encoding: "utf8" });
    expect(manifest.status, manifest.stderr).toBe(0);
    expect(JSON.parse(manifest.stdout)).toMatchObject({
      formatVersion: "3.0.0",
      dumpMode: "canonical-csv",
      dataEncoding: "base64-json-row-v1",
    });
  });

  it("stops canonical export before rows can exceed the configured payload bound", async () => {
    const files = await portableFixture({
      maxBytes: 64,
      exportUserRow: `"${"A".repeat(80)}"`,
      availableKilobytes: 300 * 1024,
    });

    const result = runPortableCreate(files);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Portable canonical export exceeds the configured limit");
    expect(await successfulPortableNames(files.backups)).toEqual([]);
  });

  it("does not mask a psql failure after complete section framing", async () => {
    const files = await portableFixture({ psqlExit: 29 });

    const result = runPortableCreate(files);

    expect(result.status).toBe(29);
    expect(await successfulPortableNames(files.backups)).toEqual([]);
  });

  it("does not invoke psql or mask failure while materializing fixed restore SQL", async () => {
    const files = await portableFixture();
    await Promise.all(canonicalCsvFiles.map((file) => writeFile(path.join(files.prepared, file), "")));

    const result = runCanonicalRestoreWithEmitterFailure(files);

    expect(result.status).toBe(37);
    await expect(readFile(files.commandLog, "utf8")).rejects.toThrow();
    expect((await readdir(files.prepared)).filter((file) => file.startsWith(".restore."))).toEqual([]);
  });

  it("publishes one inspected age archive and only then prunes the sixth backup", async () => {
    const files = await portableFixture({ existingBackups: 5 });
    const result = runPortableCreate(files);
    expect(result.status, result.stderr).toBe(0);
    expect(await successfulPortableNames(files.backups)).toEqual([
      "fitgridweb-20260903T070000Z.fitgridbackup",
      "fitgridweb-20260902T070000Z.fitgridbackup",
      "fitgridweb-20260901T070000Z.fitgridbackup",
      "fitgridweb-20260831T070000Z.fitgridbackup",
      "fitgridweb-20260830T070000Z.fitgridbackup",
    ]);
    expect(await readJson(files.history)).toMatchObject({ entries: [{ size: 321 }] });
    expect(await readJson(files.statusFile)).toEqual({ state: "ready" });
    expect((await stat(path.join(files.backups, "fitgridweb-20260903T070000Z.fitgridbackup"))).mode & 0o777).toBe(0o640);
    const commandLog = await readFile(files.commandLog, "utf8");
    expect(commandLog).toContain(
      `chown 0:1001 ${files.backups}/fitgridweb-20260903T070000Z.fitgridbackup.partial`,
    );
    expect(commandLog).toMatch(/chown 0:1001 .*\/\.history\./);
    expect(commandLog.lastIndexOf("age ")).toBeLessThan(commandLog.indexOf("chown 0:1001"));
    expect(commandLog).toContain(
      `sync -f ${files.backups}/fitgridweb-20260903T070000Z.fitgridbackup`,
    );
    expect(commandLog).toContain(`sync -f ${files.backups}`);
    expect(commandLog.lastIndexOf(`sync -f ${files.backups}`)).toBeGreaterThan(
      commandLog.indexOf(`sync -f ${files.backups}/fitgridweb-20260903T070000Z.fitgridbackup`),
    );
    expect(await recursiveNames(files.root)).not.toContainEqual(expect.stringMatching(/^\.id\./));
  });

  it("does not publish ready state or history when the filesystem durability barrier fails", async () => {
    const files = await portableFixture({ syncExit: 73 });

    const result = runPortableCreate(files);

    expect(result.status).toBe(73);
    expect(await successfulPortableNames(files.backups)).toEqual([]);
    expect(await readJson(files.history)).toEqual({ entries: [] });
    expect(await readJson(files.statusFile)).not.toEqual({ state: "ready" });
  });

  it("removes an archive when its post-rename durability barrier fails", async () => {
    const files = await portableFixture();
    const archive = path.join(files.backups, "fitgridweb-20260903T070000Z.fitgridbackup");

    const result = runPortableCreate(files, { SYNC_FAIL_TARGET: archive });

    expect(result.status).toBe(73);
    expect(await successfulPortableNames(files.backups)).toEqual([]);
    expect(await readJson(files.history)).toEqual({ entries: [] });
    expect(await readJson(files.statusFile)).not.toEqual({ state: "ready" });
  });

  it("rolls back history and removes the archive when history post-rename sync fails", async () => {
    const files = await portableFixture();
    const originalHistory = await readFile(files.history, "utf8");

    const result = runPortableCreate(files, { SYNC_FAIL_TARGET: files.history });

    expect(result.status).toBe(73);
    expect(await successfulPortableNames(files.backups)).toEqual([]);
    expect(await readFile(files.history, "utf8")).toBe(originalHistory);
    expect(await readJson(files.statusFile)).not.toEqual({ state: "ready" });
  });

  it("keeps at most five unique successful history entries when old history contains duplicates", async () => {
    const files = await portableFixture({ existingBackups: 5 });
    await writeFile(files.history, JSON.stringify({ entries: [
      { filename: "fitgridweb-20260902T070000Z.fitgridbackup", status: "ready" },
      { filename: "fitgridweb-20260902T070000Z.fitgridbackup", status: "ready" },
      { filename: "fitgridweb-20260901T070000Z.fitgridbackup", status: "ready" },
      { filename: "fitgridweb-20260831T070000Z.fitgridbackup", status: "ready" },
      { filename: "fitgridweb-20260830T070000Z.fitgridbackup", status: "ready" },
      { filename: "fitgridweb-20260829T070000Z.fitgridbackup", status: "ready" },
    ] }));
    expect(runPortableCreate(files).status).toBe(0);
    const entries = (await readJson(files.history)).entries;
    expect(entries).toHaveLength(5);
    expect(new Set(entries.map((entry: { filename: string }) => entry.filename)).size).toBe(5);
  });

  it("rejects malformed history without replacing the source file", async () => {
    const files = await portableFixture({ existingBackups: 1 });
    const malformed = "{not valid json\n";
    await writeFile(files.history, malformed);
    expect(runPortablePrune(files).status).not.toBe(0);
    expect(await readFile(files.history, "utf8")).toBe(malformed);
  });

  it("keeps all five old backups when encryption fails", async () => {
    const files = await portableFixture({ existingBackups: 5, ageExit: 9 });
    expect(runPortableCreate(files).status).toBe(9);
    expect(await successfulPortableNames(files.backups)).toHaveLength(5);
    expect(await recursiveNames(files.backups)).not.toContainEqual(expect.stringMatching(/\.partial/));
  });

  it.each([
    ["ownership", { publishChownExit: 8 }, 8],
    ["mode", { publishChmodExit: 7 }, 7],
  ] as const)("does not publish history or ciphertext when reader %s handoff fails", async (_failure, options, status) => {
    const files = await portableFixture(options);
    const result = runPortableCreate(files);
    expect(result.status).toBe(status);
    expect(await successfulPortableNames(files.backups)).toEqual([]);
    expect(await recursiveNames(files.backups)).not.toContainEqual(expect.stringMatching(/\.partial$/));
    expect(await readJson(files.history)).toEqual({ entries: [] });
    expect(await readJson(files.statusFile)).not.toEqual({ state: "ready" });
  });

  it("rejects a non-numeric portable backup reader group before publication", async () => {
    const files = await portableFixture();
    const result = runPortableCreate(files, { PORTABLE_BACKUP_READER_GID: "not-a-group" });
    expect(result.status).not.toBe(0);
    expect(await successfulPortableNames(files.backups)).toEqual([]);
    expect(await readJson(files.history)).toEqual({ entries: [] });
  });

  it.each([
    "wrong password",
    "tampered archive",
    "../escape",
    "tar extraction failure",
    "unknown format",
    "legacy full format",
    "extra manifest field",
    "count mismatch",
  ])(
    "rejects %s before publishing a prepared dump",
    async (caseName) => {
      const files = await portableInspectFixture(caseName);
      expect(runPortableInspect(files, files.archive).status).not.toBe(0);
      expect(await recursiveNames(files.prepared)).toEqual([]);
    },
  );

  it("accepts only a v3 canonical archive and preserves tricky JSON, CSV punctuation, and newlines as data", async () => {
    const files = await portableFixture();
    const manifest = JSON.stringify({
      format: "fitgridweb-portable-backup",
      formatVersion: "3.0.0",
      dumpMode: "canonical-csv",
      dataEncoding: "base64-json-row-v1",
      createdAt: "2026-09-03T07:00:00Z",
      appImage: "ghcr.io/example/fitgridweb:sha-2ca7f41",
      postgresMajor: 17,
      database: "fitgridweb",
      counts: { users: 1, gridTrades: 0, invitations: 0, importPreviews: 0 },
    });
    const tricky = { name: "逗号, 引号\"\n\\.\n不是 SQL; DROP TABLE users;", payload: { nested: "line\nline" } };
    const archive = await createCanonicalTar(files.root, "canonical.fitgridbackup", manifest, {
      "users.csv": canonicalCsvRow(tricky),
    });

    const result = runPortableInspect(files, archive);

    expect(result.status, result.stderr).toBe(0);
    const preparedTar = path.join(files.prepared, "payload.tar");
    expect((await stat(preparedTar)).mode & 0o777).toBe(0o600);
    const users = spawnSync("tar", ["-xOf", preparedTar, "users.csv"], { encoding: "utf8" });
    expect(users.status, users.stderr).toBe(0);
    expect(users.stdout).toBe(canonicalCsvRow(tricky));
  });

  it("rejects the previous v2 custom-dump portable format", async () => {
    const files = await portableFixture();
    const manifest = JSON.stringify({
      format: "fitgridweb-portable-backup",
      formatVersion: "2.0.0",
      dumpMode: "data-only",
      createdAt: "2026-09-03T07:00:00Z",
      appImage: "ghcr.io/example/fitgridweb:sha-2ca7f41",
      postgresMajor: 17,
      database: "fitgridweb",
      counts: { users: 1, gridTrades: 0, invitations: 0, importPreviews: 0 },
    });
    const archive = await createTar(files.root, "v2.fitgridbackup", manifest, "custom archive with hidden copyStmt");

    expect(runPortableInspect(files, archive).status).not.toBe(0);
    expect(await recursiveNames(files.prepared)).toEqual([]);
  });

  it("admits inspection disk space before allocating decrypted plaintext", async () => {
    const files = await portableFixture({ maxBytes: 100 * 1024 * 1024, availableKilobytes: 300 * 1024 });
    const archive = path.join(files.root, "space.fitgridbackup");
    await writeFile(archive, "encrypted input");

    const result = runPortableInspect(files, archive);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Insufficient free space for portable backup inspection");
    await expect(readFile(files.commandLog, "utf8")).rejects.toThrow();
  });

  it.each(["\\.\nDROP TABLE users;\n", '"not-base64!"\n', '"e30="\nSELECT 1;\n'])(
    "rejects non-canonical CSV framing before preparing uploaded data",
    async (usersCsv) => {
      const files = await portableFixture();
      const manifest = JSON.stringify({
        format: "fitgridweb-portable-backup",
        formatVersion: "3.0.0",
        dumpMode: "canonical-csv",
        dataEncoding: "base64-json-row-v1",
        createdAt: "2026-09-03T07:00:00Z",
        appImage: "ghcr.io/example/fitgridweb:sha-2ca7f41",
        postgresMajor: 17,
        database: "fitgridweb",
        counts: { users: 1, gridTrades: 0, invitations: 0, importPreviews: 0 },
      });
      const archive = await createCanonicalTar(files.root, "invalid.fitgridbackup", manifest, { "users.csv": usersCsv });

      const result = runPortableInspect(files, archive);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("invalid canonical CSV rows");
      expect(await recursiveNames(files.prepared)).toEqual([]);
    },
  );

  it.each(["hostile checksum filename", "multiple checksum records"])(
    "rejects %s before invoking sha256sum or publishing a prepared dump",
    async (caseName) => {
      const files = await portableInspectFixture(caseName);
      expect(runPortableInspect(files, files.archive).status).not.toBe(0);
      expect(await recursiveNames(files.prepared)).toEqual([]);
      expect(await readFile(files.commandLog, "utf8")).not.toContain("sha256sum -c");
    },
  );

  it("atomically publishes a verified canonical payload with private permissions", async () => {
    const files = await portableInspectFixture("valid archive");
    const result = runPortableInspect(files, files.archive);
    expect(result.status, result.stderr).toBe(0);
    expect((await stat(path.join(files.prepared, "payload.tar"))).mode & 0o777).toBe(0o600);
    expect(await readJson(path.join(files.root, "result.json"))).toMatchObject({
      formatVersion: "3.0.0",
      dumpMode: "canonical-csv",
      dataEncoding: "base64-json-row-v1",
      postgresMajor: 17,
    });
  });

  it("rejects an upload whose name is not a portable-backup filename", async () => {
    const files = await portableInspectFixture("valid archive");
    const wrongExtension = path.join(files.root, "upload.tar");
    await writeFile(wrongExtension, await readFile(files.archive));
    expect(runPortableInspect(files, wrongExtension).status).not.toBe(0);
    expect(await recursiveNames(files.prepared)).toEqual([]);
  });

  it("does not publish a prepared dump when result publication fails", async () => {
    const files = await portableInspectFixture("valid archive");
    const blockedParent = path.join(files.root, "blocked-result-parent");
    await writeFile(blockedParent, "not a directory");
    const result = runPortableInspect(files, files.archive, path.join(blockedParent, "result.json"));
    expect(result.status).not.toBe(0);
    expect(await recursiveNames(files.prepared)).toEqual([]);
  });

  it("creates a portable archive from a TTY without exposing its passphrase", async () => {
    const files = await portableFixture();
    const passphrase = "secret-12345";
    const expectScript = path.join(files.root, "backup.expect");
    await writeFile(expectScript, [
      "#!/usr/bin/expect -f",
      "set timeout 10",
      `set env(PATH) \"${files.bin}:${process.env.PATH}\"`,
      `set env(ENV_FILE) \"${files.environmentFile}\"`,
      `set env(COMMAND_LOG) \"${files.commandLog}\"`,
      "set env(FITGRID_BACKUP_TIMESTAMP) 20260903T070000Z",
      `spawn -noecho sh \"${path.join(projectDirectory, "ops/backup-portable.sh")}\"`,
      "expect \"独立备份密码\"",
      `send -- \"${passphrase}\\r\"`,
      "expect \"再次输入独立备份密码\"",
      `send -- \"${passphrase}\\r\"`,
      "expect eof",
    ].join("\n"));
    await chmod(expectScript, 0o700);

    const result = spawnSync("expect", [expectScript], { cwd: projectDirectory, encoding: "utf8", env: testEnvironment(files) });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(await successfulPortableNames(files.backups)).toEqual(["fitgridweb-20260903T070000Z.fitgridbackup"]);
    const transcript = `${result.stdout}${result.stderr}${await readFile(files.commandLog, "utf8")}`;
    expect(transcript).not.toContain(passphrase);
    expect(await recursiveNames(files.root)).not.toContainEqual(expect.stringMatching(/fitgrid-portable-passphrase/));
  });

  it("re-prompts for mismatched and short TTY passphrases", async () => {
    const files = await portableFixture();
    const expectScript = path.join(files.root, "retry.expect");
    await writeFile(expectScript, [
      "#!/usr/bin/expect -f",
      "set timeout 10",
      `set env(PATH) \"${files.bin}:${process.env.PATH}\"`,
      `set env(ENV_FILE) \"${files.environmentFile}\"`,
      `set env(COMMAND_LOG) \"${files.commandLog}\"`,
      "set env(FITGRID_BACKUP_TIMESTAMP) 20260903T070000Z",
      `spawn -noecho sh \"${path.join(projectDirectory, "ops/backup-portable.sh")}\"`,
      "expect \"独立备份密码\"",
      "send -- \"short\\r\"",
      "expect \"再次输入独立备份密码\"",
      "send -- \"short\\r\"",
      "expect \"独立备份密码\"",
      "send -- \"secret-12345\\r\"",
      "expect \"再次输入独立备份密码\"",
      "send -- \"different-secret\\r\"",
      "expect \"独立备份密码\"",
      "send -- \"secret-12345\\r\"",
      "expect \"再次输入独立备份密码\"",
      "send -- \"secret-12345\\r\"",
      "expect eof",
    ].join("\n"));
    await chmod(expectScript, 0o700);
    const result = spawnSync("expect", [expectScript], { cwd: projectDirectory, encoding: "utf8", env: testEnvironment(files) });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(await successfulPortableNames(files.backups)).toHaveLength(1);
  });
});
