import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const projectDirectory = process.cwd();

async function executable(directory: string, name: string, source: string) {
  const file = path.join(directory, name);
  await writeFile(file, `#!/bin/sh\nset -eu\n${source}\n`);
  await chmod(file, 0o700);
}

async function fixture() {
  const root = path.join(tmpdir(), `fitgrid-ops-${randomUUID()}`);
  const bin = path.join(root, "bin");
  const backups = path.join(root, "backups");
  const remote = path.join(root, "remote");
  await mkdir(bin, { recursive: true });
  await mkdir(backups);
  await mkdir(remote);
  const environmentFile = path.join(root, ".env");
  const commandLog = path.join(root, "commands.log");
  const keyFile = path.join(root, "backup.key");
  await writeFile(keyFile, "test-only-encryption-key");
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
    `BACKUP_DIR=${backups}`,
    `BACKUP_REMOTE_DIR=${remote}`,
    `BACKUP_ENCRYPTION_KEY_FILE=${keyFile}`,
  ].join("\n"));
  await chmod(environmentFile, 0o600);
  return { root, bin, backups, remote, environmentFile, commandLog, keyFile };
}

function run(script: string, fixturePath: Awaited<ReturnType<typeof fixture>>, extra = {}) {
  return spawnSync("sh", [path.join(projectDirectory, "ops", script)], {
    cwd: projectDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixturePath.bin}:${process.env.PATH}`,
      ENV_FILE: fixturePath.environmentFile,
      COMMAND_LOG: fixturePath.commandLog,
      ...extra,
    },
  });
}

describe("deployment script", () => {
  it("does not start a new app when migration fails", async () => {
    const files = await fixture();
    await executable(files.bin, "docker", `
printf '%s\n' "$*" >>"$COMMAND_LOG"
case "$*" in *"prisma migrate deploy"*) exit 7 ;; esac
exit 0`);
    await executable(files.bin, "curl", "exit 0");

    const result = run("deploy.sh", files);
    expect(result.status).toBe(7);
    const calls = await readFile(files.commandLog, "utf8");
    expect(calls).toContain("prisma migrate deploy");
    expect(calls).not.toContain("up -d app caddy");
  });
});

describe("backup script", () => {
  it("does not run retention cleanup when encryption fails", async () => {
    const files = await fixture();
    await executable(files.bin, "pg_dump", `
for argument in "$@"; do case "$argument" in --file=*) output=\${argument#--file=} ;; esac; done
printf 'valid custom dump' >"$output"`);
    await executable(files.bin, "pg_restore", "exit 0");
    await executable(files.bin, "openssl", "exit 9");
    await executable(files.bin, "find", "printf 'find %s\\n' \"$*\" >>\"$COMMAND_LOG\"");

    const result = run("backup.sh", files);
    expect(result.status).toBe(9);
    await expect(readFile(files.commandLog, "utf8")).rejects.toThrow();
  });
});

describe("restore script", () => {
  it("rejects the production target before invoking pg_restore", async () => {
    const files = await fixture();
    await executable(files.bin, "pg_restore", "printf 'pg_restore called\\n' >>\"$COMMAND_LOG\"");
    const result = spawnSync(
      "sh",
      [path.join(projectDirectory, "ops/restore.sh"), "--target", "postgresql://fitgrid_app:secret@db:5432/fitgridweb", "--backup", path.join(files.backups, "x.enc"), "--confirm"],
      {
        cwd: projectDirectory,
        encoding: "utf8",
        env: { ...process.env, PATH: `${files.bin}:${process.env.PATH}`, ENV_FILE: files.environmentFile, COMMAND_LOG: files.commandLog },
      },
    );
    expect(result.status).toBe(1);
    await expect(readFile(files.commandLog, "utf8")).rejects.toThrow();
  });
});
