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
  await executable(bin, "df", 'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 20971520 1 ${DISK_AVAILABLE_KB:-10485760} 1%% /\\n"');
  await executable(bin, "openssl", `
n=0
[ ! -f "${counter}" ] || n=$(cat "${counter}")
n=$((n + 1))
printf '%s' "$n" >"${counter}"
printf '%064x\\n' "$n"`);
  await executable(bin, "git", 'printf "%s\\n" "${GIT_SHA:-2ca7f41000000000000000000000000000000000}\trefs/heads/main"');
  await executable(bin, "docker", 'printf "docker %s\\n" "$*" >>"$COMMAND_LOG"; [ "${MANIFEST_OK:-1}" = 1 ]');
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

    expect(run("assert_public_image ghcr.io/zhshy7713950/fitgridweb:sha-2ca7f41000000000000000000000000000000000", files, { MANIFEST_OK: "0" }).status).toBe(1);
  });

  it("rejects an occupied app port unless FitGrid owns it", async () => {
    const files = await fixture();
    expect(run("assert_app_port_available 3300", files, { PORT_BUSY: "1" }).status).toBe(1);
    expect(run("assert_app_port_available 3300", files, { PORT_BUSY: "0" }).status).toBe(0);
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
});
