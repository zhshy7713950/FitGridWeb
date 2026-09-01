import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const library = path.join(process.cwd(), "ops/lib/install-deploy.sh");
const newImage = "ghcr.io/zhshy7713950/fitgridweb:sha-2ca7f41000000000000000000000000000000000";
const oldImage = "ghcr.io/zhshy7713950/fitgridweb:sha-1ca7f41000000000000000000000000000000000";

async function executable(directory: string, name: string, body: string) {
  const file = path.join(directory, name);
  await writeFile(file, `#!/bin/sh\nset -eu\n${body}\n`);
  await chmod(file, 0o700);
}

async function fixture() {
  const root = path.join(tmpdir(), `fitgrid-deploy-${randomUUID()}`);
  const bin = path.join(root, "bin");
  const project = path.join(root, "project");
  await mkdir(bin, { recursive: true });
  await mkdir(project);
  await writeFile(path.join(project, "docker-compose.yml"), "services: {}\n");
  await writeFile(path.join(project, "docker-compose.low-memory.yml"), "services: {}\n");
  const environment = path.join(root, "fitgridweb.env");
  const oldEnvironment = path.join(root, "old.env");
  const log = path.join(root, "commands.log");
  const common = [
    "DOMAIN=grid.example.com",
    "APP_PORT=3300",
    "PUBLIC_HTTPS_PORT=443",
    "POSTGRES_DB=fitgridweb",
    "POSTGRES_USER=fitgrid_migrate",
    "MIGRATION_DATABASE_URL=postgresql://fitgrid_migrate:secret@db:5432/fitgridweb",
  ];
  await writeFile(environment, [`APP_IMAGE=${newImage}`, ...common].join("\n") + "\n");
  await writeFile(oldEnvironment, [`APP_IMAGE=${oldImage}`, ...common].join("\n") + "\n");
  await executable(bin, "docker", `
printf 'docker %s\\n' "$*" >>"$COMMAND_LOG"
case "$*" in
  *"prisma migrate deploy"*) [ "\${MIGRATION_OK:-1}" = 1 ] ;;
  *) exit 0 ;;
esac`);
  await executable(bin, "curl", 'printf "curl %s\\n" "$*" >>"$COMMAND_LOG"; [ "${HEALTH_OK:-1}" = 1 ]');
  await executable(bin, "sleep", ":");
  return { root, bin, project, environment, oldEnvironment, log };
}

function run(command: string, files: Awaited<ReturnType<typeof fixture>>, env: Record<string, string> = {}) {
  return spawnSync("sh", ["-c", `. "${library}"; ${command}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${files.bin}:${process.env.PATH}`,
      COMMAND_LOG: files.log,
      FITGRID_HEALTH_ATTEMPTS: "1",
      ...env,
    },
  });
}

describe("deployment state machine", () => {
  it("does not update the app when migration fails", async () => {
    const files = await fixture();
    const result = run(`deploy_release "${files.project}" "${files.environment}" "${files.oldEnvironment}" 3300`, files, { MIGRATION_OK: "0" });
    expect(result.status).toBe(1);
    const log = await readFile(files.log, "utf8");
    expect(log).toContain("node_modules/.bin/prisma migrate deploy");
    expect(log).not.toContain("postgresql://fitgrid_migrate:secret");
    expect(log).not.toContain("up --no-build -d --wait app");
    expect(log).not.toMatch(/down|-v|volume rm|system prune/);
  });

  it("restores only the old app image after a health failure", async () => {
    const files = await fixture();
    const result = run(`deploy_release "${files.project}" "${files.environment}" "${files.oldEnvironment}" 3300`, files, { HEALTH_OK: "0" });
    expect(result.status).toBe(1);
    expect(await readFile(files.environment, "utf8")).toContain(`APP_IMAGE=${oldImage}`);
    const log = await readFile(files.log, "utf8");
    expect((log.match(/up --no-build -d --wait app/g) ?? [])).toHaveLength(2);
    expect(log).not.toMatch(/down|-v|volume rm|system prune/);
  });

  it("verifies loopback and public health endpoints", async () => {
    const files = await fixture();
    expect(run(`deploy_release "${files.project}" "${files.environment}" "${files.oldEnvironment}" 3300`, files).status).toBe(0);
    expect(run("verify_health https://grid.example.com/fitgrid/api/v1/health", files).status).toBe(0);
    const log = await readFile(files.log, "utf8");
    expect(log).toContain("http://127.0.0.1:3300/fitgrid/api/v1/health");
    expect(log).toContain("https://grid.example.com/fitgrid/api/v1/health");
  });

  it("delegates administrator password entry to the interactive CLI", async () => {
    const files = await fixture();
    expect(run(`create_initial_admin "${files.project}" "${files.environment}"`, files).status).toBe(0);
    const log = await readFile(files.log, "utf8");
    expect(log).toContain("run --rm --no-deps app node_modules/.bin/tsx src/server/cli/create-admin.ts");
    expect(log).not.toMatch(/password=/i);
  });

  it("does not require Corepack or network access inside read-only runtime containers", async () => {
    const source = await readFile(library, "utf8");
    expect(source).not.toMatch(/\bpnpm\b/);
    expect(source).toContain("node_modules/.bin/prisma migrate deploy");
    expect(source).toContain("node_modules/.bin/tsx src/server/cli/create-admin.ts");
  });

  it("coordinates rollback for nginx, systemd, and final health failures", async () => {
    const source = await readFile(library, "utf8");
    expect(source).toMatch(/if ! install_nginx_include[\s\S]*rollback_release/);
    expect(source).toMatch(/if ! install_systemd_unit[\s\S]*rollback_release/);
    expect(source).toMatch(/if ! systemctl restart fitgridweb\.service[\s\S]*rollback_release/);
    expect((source.match(/rollback_release /g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
