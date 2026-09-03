import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const projectDirectory = process.cwd();

type PortableFixtureOptions = {
  ageExit?: number;
  existingBackups?: number;
};

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

async function portableFixture(options: PortableFixtureOptions = {}) {
  const root = path.join(tmpdir(), `fitgrid-portable-${randomUUID()}`);
  const bin = path.join(root, "bin");
  const backups = path.join(root, "backups");
  const prepared = path.join(root, "prepared");
  const environmentFile = path.join(root, ".env");
  const passphrase = path.join(root, "passphrase");
  const history = path.join(root, "history.json");
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
    "PORTABLE_BACKUP_MAX_BYTES=536870912",
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
  *"pg_dump"*) printf 'valid custom dump' ;;
  *"pg_restore --list"*) cat >/dev/null ;;
  *"pg_database_size"*) printf '1024\\n' ;;
  *"server_version_num"*) printf '170006\\n' ;;
  *"COUNT(*)"*) printf '2|24|1|0\\n' ;;
esac`);
  await executable(bin, "age", `
printf 'age %s\\n' "$*" >>"$COMMAND_LOG"
[ "\${AGE_EXIT:-0}" = 0 ] || exit "$AGE_EXIT"
cat`);
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

  return { root, bin, backups, prepared, environmentFile, passphrase, history, commandLog, ageExit: options.ageExit ?? 0 };
}

function testEnvironment(files: Awaited<ReturnType<typeof portableFixture>>, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    PATH: `${files.bin}:${process.env.PATH}`,
    ENV_FILE: files.environmentFile,
    COMMAND_LOG: files.commandLog,
    AGE_EXIT: String(files.ageExit),
    FITGRID_BACKUP_TIMESTAMP: "20260903T070000Z",
    TMPDIR: files.root,
    ...extra,
  };
}

function runPortableCreate(files: Awaited<ReturnType<typeof portableFixture>>) {
  return spawnSync("sh", ["-c", `. \"${path.join(projectDirectory, "ops/lib/portable-backup.sh")}\"; . \"${path.join(projectDirectory, "ops/env.sh")}\"; load_fitgrid_environment; create_portable_backup \"$PASSPHRASE_FILE\" \"$PORTABLE_BACKUP_DIR\" \"$PORTABLE_BACKUP_HISTORY_FILE\"`], {
    cwd: projectDirectory,
    encoding: "utf8",
    env: testEnvironment(files, { PASSPHRASE_FILE: files.passphrase }),
  });
}

function runPortableInspect(files: Awaited<ReturnType<typeof portableFixture>>, archive: string) {
  return spawnSync("sh", ["-c", `. \"${path.join(projectDirectory, "ops/lib/portable-backup.sh")}\"; . \"${path.join(projectDirectory, "ops/env.sh")}\"; load_fitgrid_environment; inspect_portable_backup \"$ARCHIVE\" \"$PASSPHRASE_FILE\" \"$PREPARED_DIRECTORY\" \"$RESULT_FILE\"`], {
    cwd: projectDirectory,
    encoding: "utf8",
    env: testEnvironment(files, {
      ARCHIVE: archive,
      PASSPHRASE_FILE: files.passphrase,
      PREPARED_DIRECTORY: files.prepared,
      RESULT_FILE: path.join(files.root, "result.json"),
    }),
  });
}

async function portableInspectFixture(caseName: string) {
  const files = await portableFixture();
  const manifest = JSON.stringify({
    format: "fitgridweb-portable-backup",
    formatVersion: caseName === "unknown format" ? "2.0.0" : "1.0.0",
    createdAt: "2026-09-03T07:00:00Z",
    appImage: "ghcr.io/example/fitgridweb:sha-2ca7f41",
    postgresMajor: 17,
    database: "fitgridweb",
    counts: { users: 2, gridTrades: 24, invitations: 1, importPreviews: 0 },
  });
  const archive = await createTar(files.root, "upload.fitgridbackup", manifest, caseName === "tampered archive" ? "tampered" : "valid custom dump");
  if (caseName === "tampered archive") {
    const payload = path.join(files.root, "upload.fitgridbackup-payload", "database.dump.sha256");
    await writeFile(payload, "0000000000000000000000000000000000000000000000000000000000000000  database.dump\n");
    const tar = spawnSync("tar", ["-cf", archive, "manifest.json", "database.dump", "database.dump.sha256"], { cwd: path.dirname(payload), encoding: "utf8" });
    if (tar.status !== 0) throw new Error(tar.stderr);
  }
  if (caseName === "wrong password") files.ageExit = 1;
  if (caseName === "../escape") {
    await executable(files.bin, "tar", `
case "$1" in
  -tf) printf '../escape\\n' ;;
  *) exec /usr/bin/tar "$@" ;;
esac`);
  }
  return { ...files, archive };
}

describe("portable backups", () => {
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
    expect(await recursiveNames(files.root)).not.toContainEqual(expect.stringMatching(/^\.id\./));
  });

  it("keeps all five old backups when encryption fails", async () => {
    const files = await portableFixture({ existingBackups: 5, ageExit: 9 });
    expect(runPortableCreate(files).status).toBe(9);
    expect(await successfulPortableNames(files.backups)).toHaveLength(5);
    expect(await recursiveNames(files.backups)).not.toContainEqual(expect.stringMatching(/\.partial/));
  });

  it.each(["wrong password", "tampered archive", "../escape", "unknown format"])(
    "rejects %s before publishing a prepared dump",
    async (caseName) => {
      const files = await portableInspectFixture(caseName);
      expect(runPortableInspect(files, files.archive).status).not.toBe(0);
      expect(await recursiveNames(files.prepared)).toEqual([]);
    },
  );

  it("atomically publishes a verified custom dump with private permissions", async () => {
    const files = await portableInspectFixture("valid archive");
    const result = runPortableInspect(files, files.archive);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(path.join(files.prepared, "database.dump"), "utf8")).toBe("valid custom dump");
    expect((await stat(path.join(files.prepared, "database.dump"))).mode & 0o777).toBe(0o600);
    expect(await readJson(path.join(files.root, "result.json"))).toMatchObject({ formatVersion: "1.0.0", postgresMajor: 17 });
  });

  it("rejects an upload whose name is not a portable-backup filename", async () => {
    const files = await portableInspectFixture("valid archive");
    const wrongExtension = path.join(files.root, "upload.tar");
    await writeFile(wrongExtension, await readFile(files.archive));
    expect(runPortableInspect(files, wrongExtension).status).not.toBe(0);
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
