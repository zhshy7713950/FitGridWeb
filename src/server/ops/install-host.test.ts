import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const library = path.join(process.cwd(), "ops/lib/install-host.sh");
const unitTemplate = path.join(process.cwd(), "ops/templates/fitgridweb.service");

async function executable(directory: string, name: string, body: string) {
  const file = path.join(directory, name);
  await writeFile(file, `#!/bin/sh\nset -eu\n${body}\n`);
  await chmod(file, 0o700);
}

async function fixture(swapKilobytes = 0) {
  const root = path.join(tmpdir(), `fitgrid-host-${randomUUID()}`);
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const log = path.join(root, "commands.log");
  const swaps = path.join(root, "swaps");
  const swapfile = path.join(root, "swapfile-fitgridweb");
  const fstab = path.join(root, "fstab");
  const aptRoot = path.join(root, "apt");
  const release = path.join(root, "os-release");
  const unit = path.join(root, "fitgridweb.service");
  await writeFile(swaps, swapKilobytes ? `Filename Type Size Used Priority\n/dev/existing partition ${swapKilobytes} 0 -2\n` : "Filename Type Size Used Priority\n");
  await writeFile(fstab, "UUID=root / ext4 defaults 0 1\n");
  await writeFile(release, "VERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n");
  await executable(bin, "fallocate", 'printf "fallocate %s\\n" "$*" >>"$COMMAND_LOG"; eval "target=\\${$#}"; : >"$target"');
  await executable(bin, "mkswap", 'printf "mkswap %s\\n" "$*" >>"$COMMAND_LOG"');
  await executable(bin, "swapon", 'printf "swapon %s\\n" "$*" >>"$COMMAND_LOG"');
  await executable(bin, "systemctl", 'printf "systemctl %s\\n" "$*" >>"$COMMAND_LOG"');
  await executable(bin, "apt-get", 'printf "apt-get %s\\n" "$*" >>"$COMMAND_LOG"');
  await executable(bin, "dpkg", 'printf "amd64\\n"');
  await executable(bin, "curl", 'while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then printf key >"$2"; exit 0; fi; shift; done; exit 1');
  return { root, bin, log, swaps, swapfile, fstab, aptRoot, release, unit };
}

function run(command: string, files: Awaited<ReturnType<typeof fixture>>) {
  return spawnSync("sh", ["-c", `. "${library}"; ${command}`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${files.bin}:${process.env.PATH}`, COMMAND_LOG: files.log },
  });
}

describe("host dependencies", () => {
  it("configures Docker's official apt source before installing packages", async () => {
    const files = await fixture();
    const result = run(`install_dependencies "${files.aptRoot}" "${files.release}"`, files);
    expect(result.status, result.stderr).toBe(0);
    const source = await readFile(path.join(files.aptRoot, "sources.list.d/docker.sources"), "utf8");
    expect(source).toContain("https://download.docker.com/linux/ubuntu");
    expect(source).toContain("Suites: noble");
    const log = await readFile(files.log, "utf8");
    expect(log).toContain("docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin");
  });
});

describe("swap management", () => {
  it("does nothing when total swap is already at least 2 GiB", async () => {
    const files = await fixture(3 * 1024 * 1024);
    expect(run(`ensure_swap yes "${files.swapfile}" "${files.fstab}" "${files.swaps}"`, files).status).toBe(0);
    await expect(readFile(files.log, "utf8")).rejects.toThrow();
    expect(await readFile(files.fstab, "utf8")).not.toContain("fitgridweb-managed");
  });

  it("creates only the missing swap and leaves one persistent entry", async () => {
    const files = await fixture(1024 * 1024);
    const command = `ensure_swap yes "${files.swapfile}" "${files.fstab}" "${files.swaps}"`;
    expect(run(command, files).status).toBe(0);
    expect(run(command, files).status).toBe(0);
    const log = await readFile(files.log, "utf8");
    expect(log).toContain("fallocate -l 1048576K");
    expect((await readFile(files.fstab, "utf8")).match(/fitgridweb-managed/g)).toHaveLength(1);
  });
});

describe("boot recovery", () => {
  it("starts only db and app through the two Compose files", async () => {
    const source = await readFile(unitTemplate, "utf8");
    expect(source).toContain("Requires=docker.service");
    expect(source).toContain("After=network-online.target docker.service");
    expect(source).toContain("docker-compose.low-memory.yml up -d --wait db app");
    expect(source).toContain("docker-compose.low-memory.yml stop app db");
    expect(source).not.toMatch(/caddy|sing-box|ufw|firewall/i);

    const files = await fixture();
    expect(run(`install_systemd_unit "${unitTemplate}" "${files.unit}"`, files).status).toBe(0);
    expect(await readFile(files.unit, "utf8")).toBe(source);
    expect(await readFile(files.log, "utf8")).toContain("systemctl enable fitgridweb.service");
  });
});
