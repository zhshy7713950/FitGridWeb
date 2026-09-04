import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
  const environmentBackup = path.join(root, "install-backup.env");
  const nginxTemporary = path.join(root, "nginx-temporary");
  await mkdir(nginxTemporary);
  const log = path.join(root, "commands.log");
  const common = [
    "DOMAIN=grid.example.com",
    "APP_PORT=3300",
    "PUBLIC_HTTPS_PORT=443",
    "POSTGRES_DB=fitgridweb",
    "POSTGRES_USER=fitgrid_migrate",
    "MIGRATION_DATABASE_URL=postgresql://fitgrid_migrate:secret@db:5432/fitgridweb",
    "PORTABLE_BACKUP_MAX_BYTES=536870912",
  ];
  await writeFile(environment, [`APP_IMAGE=${newImage}`, ...common].join("\n") + "\n");
  await writeFile(oldEnvironment, [`APP_IMAGE=${oldImage}`, ...common].join("\n") + "\n");
  await executable(bin, "docker", `
printf 'docker %s\\n' "$*" >>"$COMMAND_LOG"
if [ "\${1:-} \${2:-}" = "image ls" ]; then
  printf '%s\\n' "\${LOCAL_APP_IMAGES:-}"
  exit 0
fi
if [ "\${1:-} \${2:-}" = "image rm" ]; then
  [ "\${IMAGE_RM_OK:-1}" = 1 ]
  exit
fi
case "$*" in
  *"prisma migrate deploy"*) [ "\${MIGRATION_OK:-1}" = 1 ] ;;
  *) exit 0 ;;
esac`);
  await executable(bin, "curl", 'printf "curl %s\\n" "$*" >>"$COMMAND_LOG"; [ "${HEALTH_OK:-1}" = 1 ]');
  await executable(bin, "sleep", ":");
  return { root, bin, project, environment, oldEnvironment, environmentBackup, nginxTemporary, log };
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
  it.each([
    ["first installation", false],
    ["upgrade", true],
  ])("installs every required unit before app startup during %s", async (_caseName, upgrade) => {
    const files = await fixture();
    if (!upgrade) await unlink(files.environment);
    const sha = "2ca7f41000000000000000000000000000000000";
    const command = `
validate_domain() { :; }
validate_port() { :; }
validate_nginx_site() { :; }
image_for_sha() { printf 'unused\\n'; }
assert_public_image() { :; }
install_dependencies() { :; }
assert_app_port_available() { :; }
mkdir() { :; }
mktemp() {
  if [ "\${1:-}" = -d ]; then printf '%s\\n' "${files.nginxTemporary}"; else printf '%s\\n' "${files.environmentBackup}"; fi
}
ensure_environment() { printf 'PORTABLE_BACKUP_MAX_BYTES=536870912\\n' >"$1"; }
ensure_swap() { :; }
install_maintenance_components() { printf 'phase install-maintenance\\n' >>"$COMMAND_LOG"; }
enable_maintenance_components() { printf 'phase enable-maintenance\\n' >>"$COMMAND_LOG"; }
install_systemd_unit() { printf 'phase install-app-unit\\n' >>"$COMMAND_LOG"; }
deploy_release() { printf 'phase start-app\\n' >>"$COMMAND_LOG"; }
render_nginx_snippet() { printf 'location /fitgrid {}\\n'; }
install_nginx_include() { :; }
verify_health() { printf 'phase health\\n' >>"$COMMAND_LOG"; }
systemctl() { printf 'phase %s\\n' "$*" >>"$COMMAND_LOG"; }
cleanup_old_app_images() { :; }
fitgrid_install_main grid.example.com 3300 443 /etc/nginx/conf.d/fitgridweb.conf \\
  ${sha} no no ${String(upgrade)} "${files.project}" "${files.environment}" "${files.root}/backup.key"
`;

    const result = run(command, files);

    expect(result.status, result.stderr).toBe(0);
    const phases = (await readFile(files.log, "utf8")).trim().split("\n");
    expect(phases.indexOf("phase install-maintenance")).toBeLessThan(phases.indexOf("phase install-app-unit"));
    expect(phases.indexOf("phase install-app-unit")).toBeLessThan(phases.indexOf("phase start-app"));
    expect(phases).toContain("phase enable-maintenance");
    expect(phases.indexOf("phase enable-maintenance")).toBeGreaterThan(phases.lastIndexOf("phase health"));
    expect(phases.indexOf("phase enable-maintenance")).toBeLessThan(phases.indexOf("phase enable fitgridweb.service"));
    expect(phases).toContain("phase enable fitgridweb.service");
    expect(phases.indexOf("phase enable fitgridweb.service")).toBeGreaterThan(phases.lastIndexOf("phase health"));
  });

  it("removes only old SHA images from the repository derived from APP_IMAGE", async () => {
    const files = await fixture();
    const currentImage = "ghcr.io/acme-owner/renamed-app:sha-2ca7f41000000000000000000000000000000000";
    const previousImage = "ghcr.io/acme-owner/renamed-app:sha-1ca7f41000000000000000000000000000000000";
    const unrelatedImage = "ghcr.io/another-owner/renamed-app:sha-0ca7f41000000000000000000000000000000000";
    await writeFile(files.environment, `APP_IMAGE=${currentImage}\n`);

    const result = run(`cleanup_old_app_images "${files.environment}"`, files, {
      LOCAL_APP_IMAGES: [currentImage, previousImage, unrelatedImage].join("\n"),
    });

    expect(result.status).toBe(0);
    const log = await readFile(files.log, "utf8");
    expect(log.trim().split("\n")).toEqual([
      "docker image ls --filter reference=ghcr.io/acme-owner/renamed-app:sha-* --format {{.Repository}}:{{.Tag}}",
      `docker image rm ${previousImage}`,
    ]);
  });

  it("reports an old-image removal failure without forcing deletion", async () => {
    const files = await fixture();
    const currentImage = "registry.example.com:5000/team/app:sha-2ca7f41000000000000000000000000000000000";
    const previousImage = "registry.example.com:5000/team/app:sha-1ca7f41000000000000000000000000000000000";
    await writeFile(files.environment, `APP_IMAGE=${currentImage}\n`);

    const result = run(`cleanup_old_app_images "${files.environment}"`, files, {
      LOCAL_APP_IMAGES: [currentImage, previousImage].join("\n"),
      IMAGE_RM_OK: "0",
    });

    expect(result.status).toBe(1);
    const log = await readFile(files.log, "utf8");
    expect(log.trim().split("\n")).toEqual([
      "docker image ls --filter reference=registry.example.com:5000/team/app:sha-* --format {{.Repository}}:{{.Tag}}",
      `docker image rm ${previousImage}`,
    ]);
  });

  it("runs image cleanup after a successful install and keeps cleanup failure non-fatal", async () => {
    const files = await fixture();
    const currentImage = "ghcr.io/transferred-owner/fitgridweb:sha-2ca7f41000000000000000000000000000000000";
    const previousImage = "ghcr.io/transferred-owner/fitgridweb:sha-1ca7f41000000000000000000000000000000000";
    await writeFile(files.environment, `APP_IMAGE=${currentImage}\n`);
    const sha = "2ca7f41000000000000000000000000000000000";
    const command = `
validate_domain() { :; }
validate_port() { :; }
validate_nginx_site() { :; }
image_for_sha() { printf 'unused\\n'; }
assert_public_image() { :; }
install_dependencies() { :; }
assert_app_port_available() { :; }
mkdir() { :; }
mktemp() {
  if [ "\${1:-}" = -d ]; then
    printf '%s\\n' "${files.nginxTemporary}"
  else
    printf '%s\\n' "${files.environmentBackup}"
  fi
}
ensure_environment() { :; }
ensure_swap() { :; }
deploy_release() { :; }
render_nginx_snippet() { printf 'phase render-nginx %s\\n' "$*" >>"$COMMAND_LOG"; printf 'location /fitgrid {}\\n'; }
install_nginx_include() { :; }
verify_health() { printf 'phase health\\n' >>"$COMMAND_LOG"; }
install_systemd_unit() { printf 'phase install-systemd\\n' >>"$COMMAND_LOG"; }
systemctl() { printf 'phase restart-systemd\\n' >>"$COMMAND_LOG"; }
install_maintenance_components() { printf 'phase install-maintenance\\n' >>"$COMMAND_LOG"; }
enable_maintenance_components() { printf 'phase enable-maintenance\\n' >>"$COMMAND_LOG"; }
create_initial_admin() { :; }
fitgrid_install_main grid.example.com 3300 443 /etc/nginx/conf.d/fitgridweb.conf \
  ${sha} no no true "${files.project}" "${files.environment}" "${files.root}/backup.key"
`;

    const result = run(command, files, {
      LOCAL_APP_IMAGES: [currentImage, previousImage].join("\n"),
      IMAGE_RM_OK: "0",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FitGridWeb 部署完成");
    expect(result.stderr).toContain("旧镜像清理失败");
    const log = await readFile(files.log, "utf8");
    expect(log).toContain(`image rm ${previousImage}`);
    expect(log.indexOf("docker image ls")).toBeGreaterThan(log.indexOf("phase restart-systemd"));
    expect(log.indexOf("docker image ls")).toBeGreaterThan(log.lastIndexOf("phase health"));
    expect(log).toContain("phase render-nginx 3300 536870912");
    expect(log.indexOf("phase install-maintenance")).toBeLessThan(log.indexOf("phase health"));
  });

  it("does not start a new app when pre-start maintenance installation fails", async () => {
    const files = await fixture();
    await writeFile(files.environment, await readFile(files.oldEnvironment, "utf8"));
    const sha = "2ca7f41000000000000000000000000000000000";
    const command = `
validate_domain() { :; }
validate_port() { :; }
validate_nginx_site() { :; }
image_for_sha() { printf 'unused\\n'; }
assert_public_image() { :; }
install_dependencies() { :; }
assert_app_port_available() { :; }
mkdir() { :; }
mktemp() {
  if [ "\${1:-}" = -d ]; then printf '%s\\n' "${files.nginxTemporary}"; else printf '%s\\n' "${files.environmentBackup}"; fi
}
ensure_environment() { printf 'APP_IMAGE=${newImage}\\nPORTABLE_BACKUP_MAX_BYTES=536870912\\n' >"$1"; }
ensure_swap() { :; }
deploy_release() { printf 'phase deploy\\n' >>"$COMMAND_LOG"; }
render_nginx_snippet() { printf 'location /fitgrid {}\\n'; }
install_nginx_include() { :; }
verify_health() { printf 'phase health\\n' >>"$COMMAND_LOG"; }
install_systemd_unit() { :; }
systemctl() { printf 'phase restart-systemd\\n' >>"$COMMAND_LOG"; }
install_maintenance_components() { fitgrid_error '维护组件安装失败：logrotate'; return 9; }
rollback_release() { printf 'phase rollback\\n' >>"$COMMAND_LOG"; }
fitgrid_install_main grid.example.com 3300 443 /etc/nginx/conf.d/fitgridweb.conf \\
  ${sha} no no true "${files.project}" "${files.environment}" "${files.root}/backup.key"
`;

    const result = run(command, files);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("维护组件安装失败：logrotate");
    expect(result.stderr).toContain("新 FitGridWeb 应用尚未启动");
    expect(await readFile(files.environment, "utf8")).toContain(`APP_IMAGE=${oldImage}`);
    const log = await readFile(files.log, "utf8").catch(() => "");
    expect(log).not.toContain("phase rollback");
    expect(log).not.toMatch(/stop app|down|-v|volume rm/);
    expect(log).not.toContain("phase deploy");
    expect(log).not.toContain("phase health");
    expect(log).not.toContain("phase restart-systemd");
    expect(log).not.toContain("enable fitgridweb.service");
  });

  it.each([
    ["migration", true],
    ["health", false],
  ])("does not enable the app after a %s failure", async (failureStage, upgrade) => {
    const files = await fixture();
    if (upgrade) {
      await writeFile(files.environment, await readFile(files.oldEnvironment, "utf8"));
    } else {
      await unlink(files.environment);
    }
    const sha = "2ca7f41000000000000000000000000000000000";
    const command = `
validate_domain() { :; }
validate_port() { :; }
validate_nginx_site() { :; }
image_for_sha() { printf 'unused\\n'; }
assert_public_image() { :; }
install_dependencies() { :; }
assert_app_port_available() { :; }
mkdir() { :; }
mktemp() {
  if [ "\${1:-}" = -d ]; then printf '%s\\n' "${files.nginxTemporary}"; else printf '%s\\n' "${files.environmentBackup}"; fi
}
ensure_environment() { printf 'APP_IMAGE=${newImage}\\nPORTABLE_BACKUP_MAX_BYTES=536870912\\n' >"$1"; }
ensure_swap() { :; }
install_maintenance_components() { :; }
install_systemd_unit() { printf 'phase install-app-unit\\n' >>"$COMMAND_LOG"; }
deploy_release() { printf 'phase deploy\\n' >>"$COMMAND_LOG"; [ "${failureStage}" != migration ]; }
render_nginx_snippet() { printf 'location /fitgrid {}\\n'; }
install_nginx_include() { :; }
verify_health() { printf 'phase health\\n' >>"$COMMAND_LOG"; [ "${failureStage}" != health ]; }
systemctl() { printf 'phase %s\\n' "$*" >>"$COMMAND_LOG"; }
cleanup_old_app_images() { :; }
fitgrid_install_main grid.example.com 3300 443 /etc/nginx/conf.d/fitgridweb.conf \\
  ${sha} no no ${String(upgrade)} "${files.project}" "${files.environment}" "${files.root}/backup.key"
`;

    const result = run(command, files);

    expect(result.status).toBe(1);
    if (upgrade) {
      expect(await readFile(files.environment, "utf8")).toContain(`APP_IMAGE=${oldImage}`);
    } else {
      await expect(readFile(files.environment, "utf8")).rejects.toThrow();
    }
    const log = await readFile(files.log, "utf8");
    expect(log).not.toContain("enable fitgridweb.service");
  });

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
    expect(source.lastIndexOf("if ! install_systemd_unit"))
      .toBeLessThan(source.lastIndexOf("deploy_release \"$project_directory\""));
    expect(source).toMatch(/if ! systemctl restart fitgridweb\.service[\s\S]*rollback_release/);
    expect((source.match(/rollback_release /g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
