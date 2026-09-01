import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const library = path.join(process.cwd(), "ops/lib/install-common.sh");

async function executable(directory: string, name: string, body: string) {
  const target = path.join(directory, name);
  await writeFile(target, `#!/bin/sh\nset -eu\n${body}\n`);
  await chmod(target, 0o700);
}

async function fixture() {
  const root = path.join(tmpdir(), `fitgrid-install-common-${randomUUID()}`);
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const release = path.join(root, "os-release");
  const meminfo = path.join(root, "meminfo");
  const environment = path.join(root, "fitgridweb.env");
  const key = path.join(root, "backup.key");
  const counter = path.join(root, "counter");
  const log = path.join(root, "commands.log");
  await writeFile(release, 'ID=ubuntu\nVERSION_ID="24.04"\n');
  await writeFile(meminfo, "MemTotal:        2097152 kB\n");
  await executable(bin, "df", 'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 20971520 1 ${DISK_AVAILABLE_KB:-10485760} ${DISK_USE_PERCENT:-1}%% /\\n"');
  await executable(bin, "openssl", `
n=0
[ ! -f "${counter}" ] || n=$(cat "${counter}")
n=$((n + 1))
printf '%s' "$n" >"${counter}"
printf '%064x\\n' "$n"`);
  await executable(bin, "git", 'printf "%s\\n" "${GIT_SHA:-2ca7f41000000000000000000000000000000000}\trefs/heads/main"');
  await executable(bin, "docker", `
printf "docker %s\\n" "$*" >>"$COMMAND_LOG"
case "$*" in
  "ps --filter publish=3300 --format "*) [ "\${FITGRID_OWNS_PORT:-0}" = 1 ] && printf 'fitgridweb\\n' ;;
  ps*) : ;;
  *) [ "\${MANIFEST_OK:-1}" = 1 ] ;;
esac`);
  await executable(bin, "curl", `
case "$*" in
  *"api.github.com/repos/zhshy7713950/FitGridWeb/commits/"*) printf '{"sha": "%s"}' "\${CURL_COMMIT_SHA:-}" ;;
  *"ghcr.io/token"*) printf '{"token":"anonymous-test-token"}' ;;
  *"ghcr.io/v2/"*) [ "\${CURL_MANIFEST_OK:-0}" = 1 ] ;;
  *"https://grid.example.com"*) [ "\${CURL_HTTPS_OK:-0}" = 1 ] ;;
  *) exit 1 ;;
esac`);
  await executable(bin, "ss", '[ "${PORT_BUSY:-0}" = 1 ] && printf "LISTEN 0 4096 127.0.0.1:${APP_PORT_FOR_TEST:-3300} 0.0.0.0:*\\n" || true');
  return { root, bin, release, meminfo, environment, key, log };
}

function run(command: string, files: Awaited<ReturnType<typeof fixture>>, env: Record<string, string> = {}) {
  return spawnSync("sh", ["-c", `. "${library}"; ${command}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${files.bin}:${process.env.PATH}`,
      COMMAND_LOG: files.log,
      ...env,
    },
  });
}

describe("installer preflight", () => {
  it("completes external preflight before apt and checkout mutations", async () => {
    const installer = await readFile(path.join(process.cwd(), "ops/install-production.sh"), "utf8");
    expect(installer).not.toContain("$RAW_ROOT/main/ops/lib/install-common.sh");
    expect(installer).toContain("$RAW_ROOT/$resolved_sha/ops/lib/install-common.sh");
    expect(installer.indexOf('. "$pinned_common_library"')).toBeLessThan(installer.indexOf("apt-get update"));
    const apt = installer.indexOf("apt-get update");
    const checkout = installer.indexOf("ensure_checkout");
    for (const check of ["assert_public_image", "validate_disk_pressure", "validate_https_endpoint", "validate_nginx_site"]) {
      expect(installer.indexOf(check)).toBeGreaterThan(0);
      expect(installer.indexOf(check)).toBeLessThan(apt);
      expect(installer.indexOf(check)).toBeLessThan(checkout);
    }
  });

  it("automates a dedicated nginx endpoint without asking novices for a vhost path", async () => {
    const installer = await readFile(path.join(process.cwd(), "ops/install-production.sh"), "utf8");
    const imageGate = installer.indexOf('assert_public_image "$image"');
    const prepareSite = installer.indexOf("prepare_dedicated_nginx_site");

    expect(installer).toContain("nginx_site=/etc/nginx/conf.d/fitgridweb.conf");
    expect(installer).toContain("choose_nginx_public_port");
    expect(installer).toContain("validate_distinct_ports");
    expect(installer).toContain("FITGRID_NGINX_INSTALLER_PROTOCOL");
    expect(installer).not.toContain('prompt_value "仅含一个 server 块的 nginx vhost 文件绝对路径"');
    expect(imageGate).toBeGreaterThan(0);
    expect(prepareSite).toBeGreaterThan(imageGate);
  });

  it("accepts the supported host and rejects insufficient resources", async () => {
    const files = await fixture();
    expect(run(`validate_host "${files.release}" "${files.meminfo}" "${files.root}" x86_64`, files).status).toBe(0);

    await writeFile(files.meminfo, "MemTotal:         524288 kB\n");
    expect(run(`validate_host "${files.release}" "${files.meminfo}" "${files.root}" x86_64`, files).status).toBe(1);

    await writeFile(files.meminfo, "MemTotal:        2097152 kB\n");
    expect(run(`validate_host "${files.release}" "${files.meminfo}" "${files.root}" x86_64`, files, { DISK_AVAILABLE_KB: "4194304" }).status).toBe(1);
  });

  it("resolves only full commit SHAs and checks the public image", async () => {
    const files = await fixture();
    const resolved = run("resolve_ref https://github.com/zhshy7713950/FitGridWeb.git main", files);
    expect(resolved.status).toBe(0);
    expect(resolved.stdout.trim()).toMatch(/^[a-f0-9]{40}$/);

    const directSha = "2ca7f41000000000000000000000000000000000";
    const direct = run(`resolve_ref https://github.com/zhshy7713950/FitGridWeb.git ${directSha}`, files, { CURL_COMMIT_SHA: directSha });
    expect(direct.status, direct.stderr).toBe(0);
    expect(direct.stdout.trim()).toBe(directSha);
    expect(run(`resolve_ref https://github.com/zhshy7713950/FitGridWeb.git ${directSha}`, files, { CURL_COMMIT_SHA: "" }).status).toBe(1);

    const image = "ghcr.io/zhshy7713950/fitgridweb:sha-2ca7f41000000000000000000000000000000000";
    const unavailable = run(`assert_public_image ${image}`, files, { MANIFEST_OK: "0", CURL_MANIFEST_OK: "0" });
    expect(unavailable.status).toBe(1);
    expect(unavailable.stderr).toContain("github.com/zhshy7713950/FitGridWeb/actions");
    expect(run(`assert_public_image ${image}`, files, { MANIFEST_OK: "0", CURL_MANIFEST_OK: "1" }).status).toBe(0);
  });

  it("accepts an occupied app port when the FitGrid Compose project owns it", async () => {
    const files = await fixture();
    expect(run("assert_app_port_available 3300", files, {
      PORT_BUSY: "1",
      FITGRID_OWNS_PORT: "1",
    }).status).toBe(0);
  });

  it("rejects an occupied app port owned by another process", async () => {
    const files = await fixture();
    expect(run("assert_app_port_available 3300", files, { PORT_BUSY: "1" }).status).toBe(1);
    expect(run("assert_app_port_available 3300", files, { PORT_BUSY: "0" }).status).toBe(0);
  });

  it("prompts for another app port after an external port conflict", async () => {
    const files = await fixture();
    const result = run(`
prompt_value() { printf '3301\\n'; }
choose_app_port 3300`, files, { PORT_BUSY: "1" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("3301");
    expect(result.stderr).toContain("本地端口 3300 已被非 FitGrid 服务占用");
  });

  it("rejects using the same host port for nginx and the application", async () => {
    const files = await fixture();
    expect(run("validate_distinct_ports 443 3300", files).status).toBe(0);
    expect(run("validate_distinct_ports 3300 3300", files).status).toBe(1);
  });

  it("warns at 70 percent disk, aborts at 85 percent, and verifies existing HTTPS", async () => {
    const files = await fixture();
    const warning = run(`validate_disk_pressure "${files.root}"`, files, { DISK_USE_PERCENT: "70" });
    expect(warning.status).toBe(0);
    expect(warning.stderr).toContain("70%");
    expect(run(`validate_disk_pressure "${files.root}"`, files, { DISK_USE_PERCENT: "85" }).status).toBe(1);
    expect(run("validate_https_endpoint grid.example.com 443", files, { CURL_HTTPS_OK: "1" }).status).toBe(0);
    expect(run("validate_https_endpoint grid.example.com 443", files, { CURL_HTTPS_OK: "0" }).status).toBe(1);
  });
});

describe("installer environment", () => {
  it("creates independent secrets once and preserves them on upgrade", async () => {
    const files = await fixture();
    const args = `"${files.environment}" "${files.key}" grid.example.com 3300 443 2ca7f41000000000000000000000000000000000`;
    const first = run(`ensure_environment ${args}`, files);
    expect(first.status, first.stderr).toBe(0);
    const firstEnvironment = await readFile(files.environment, "utf8");
    const secrets = [...firstEnvironment.matchAll(/^(?:POSTGRES_PASSWORD|APP_DATABASE_PASSWORD|BETTER_AUTH_SECRET|OWNER_REF_SECRET|CURSOR_SIGNING_SECRET)=([a-f0-9]{64})$/gm)].map((match) => match[1]);
    expect(secrets).toHaveLength(5);
    expect(new Set(secrets).size).toBe(5);
    expect(first.stdout + first.stderr).not.toContain(secrets[0]);

    const second = run(`ensure_environment ${args}`, files);
    expect(second.status, second.stderr).toBe(0);
    expect(await readFile(files.environment, "utf8")).toBe(firstEnvironment);
    expect((await readFile(files.key, "utf8")).trim()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("forbids endpoint reconfiguration during an application upgrade", async () => {
    const files = await fixture();
    const create = `ensure_environment "${files.environment}" "${files.key}" grid.example.com 3300 443 2ca7f41000000000000000000000000000000000 /etc/nginx/sites-available/grid.conf`;
    expect(run(create, files).status).toBe(0);
    expect(run(`validate_upgrade_invariants "${files.environment}" grid.example.com 3300 443 /etc/nginx/sites-available/grid.conf`, files).status).toBe(0);
    expect(run(`validate_upgrade_invariants "${files.environment}" grid.example.com 3301 443 /etc/nginx/sites-available/grid.conf`, files).status).toBe(1);
  });

  it("preserves validated operator backup settings during upgrades", async () => {
    const files = await fixture();
    const command = `ensure_environment "${files.environment}" "${files.key}" grid.example.com 3300 443 2ca7f41000000000000000000000000000000000 /etc/nginx/sites-available/grid.conf`;
    expect(run(command, files).status).toBe(0);
    const configured = (await readFile(files.environment, "utf8"))
      .replace("BACKUP_DIR=/var/lib/fitgridweb/backups", "BACKUP_DIR=/srv/fitgrid-backups")
      .replace("BACKUP_REMOTE_DIR=", "BACKUP_REMOTE_DIR=/mnt/remote-fitgrid")
      .replace("BACKUP_RETENTION_DAYS=180", "BACKUP_RETENTION_DAYS=365");
    await writeFile(files.environment, configured);

    expect(run(command, files).status).toBe(0);
    const upgraded = await readFile(files.environment, "utf8");
    expect(upgraded).toContain("BACKUP_DIR=/srv/fitgrid-backups");
    expect(upgraded).toContain("BACKUP_REMOTE_DIR=/mnt/remote-fitgrid");
    expect(upgraded).toContain("BACKUP_RETENTION_DAYS=365");
  });
});
