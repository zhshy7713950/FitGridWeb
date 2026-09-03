import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const library = path.join(process.cwd(), "ops/lib/install-host.sh");
const unitTemplate = path.join(process.cwd(), "ops/templates/fitgridweb.service");
const maintenancePathTemplate = path.join(process.cwd(), "ops/templates/fitgridweb-maintenance.path");
const maintenanceServiceTemplate = path.join(process.cwd(), "ops/templates/fitgridweb-maintenance.service");
const backupServiceTemplate = path.join(process.cwd(), "ops/templates/fitgridweb-backup.service");
const backupTimerTemplate = path.join(process.cwd(), "ops/templates/fitgridweb-backup.timer");
const logrotateTemplate = path.join(process.cwd(), "ops/templates/fitgridweb-ops.logrotate");

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
  await executable(bin, "chown", 'printf "chown %s\\n" "$*" >>"$COMMAND_LOG"; [ "${CHOWN_OK:-1}" = 1 ]');
  await executable(bin, "chmod", 'printf "chmod %s\\n" "$*" >>"$COMMAND_LOG"; exec /bin/chmod "$@"');
  await executable(bin, "install", `
printf "install %s\\n" "$*" >>"$COMMAND_LOG"
target=
for install_arg do target=$install_arg; done
case " $* " in *" -d "*) mkdir -p "$target" ;; *) /usr/bin/install "$@" ;; esac`);
  await executable(bin, "findmnt", `
case "$*" in
  "--target / --noheadings --output MAJ:MIN") printf '%s\\n' "\${ROOT_DEVICE:-8:1}" ;;
  "--target "*" --noheadings --output MAJ:MIN") printf '%s\\n' "\${REMOTE_DEVICE:-8:1}" ;;
  *) exit 1 ;;
esac`);
  await executable(bin, "dpkg", 'printf "amd64\\n"');
  await executable(bin, "curl", 'while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then printf key >"$2"; exit 0; fi; shift; done; exit 1');
  return { root, bin, log, swaps, swapfile, fstab, aptRoot, release, unit };
}

function run(command: string, files: Awaited<ReturnType<typeof fixture>>, env: Record<string, string> = {}) {
  return spawnSync("sh", ["-c", `. "${library}"; ${command}`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${files.bin}:${process.env.PATH}`, COMMAND_LOG: files.log, ...env },
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
    expect(log).toContain("apt-get install -y --no-install-recommends age jq util-linux");
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
    expect(source).toContain("docker-compose.low-memory.yml up --no-build -d --wait db app");
    expect(source).toContain("docker-compose.low-memory.yml stop app db");
    expect(source).not.toMatch(/caddy|sing-box|ufw|firewall/i);

    const files = await fixture();
    expect(run(`install_systemd_unit "${unitTemplate}" "${files.unit}"`, files).status).toBe(0);
    expect(await readFile(files.unit, "utf8")).toBe(source);
    expect(await readFile(files.log, "utf8")).toContain("systemctl enable fitgridweb.service");
  });
});

describe("maintenance installation", () => {
  async function maintenanceFixture(backupRemoteDir = "") {
    const files = await fixture();
    const web = path.join(files.root, "admin-ops/web");
    const rootOps = path.join(files.root, "admin-ops/root");
    const portable = path.join(files.root, "portable-backups");
    const remote = path.join(files.root, "remote-backups");
    const environment = path.join(files.root, "fitgridweb.env");
    const systemd = path.join(files.root, "systemd");
    const logrotate = path.join(files.root, "logrotate/fitgridweb-ops");
    await mkdir(remote, { recursive: true });
    await writeFile(environment, [
      `ADMIN_OPS_WEB_DIR=${web}`,
      `ADMIN_OPS_ROOT_DIR=${rootOps}`,
      `PORTABLE_BACKUP_DIR=${portable}`,
      `PORTABLE_BACKUP_HISTORY_FILE=${web}/status/backups.json`,
      "PORTABLE_BACKUP_READER_GID=1001",
      `BACKUP_REMOTE_DIR=${backupRemoteDir ? remote : ""}`,
    ].join("\n") + "\n");
    return { ...files, web, rootOps, portable, remote, environment, systemd, logrotate };
  }

  it("installs private spool directories and enables only the maintenance path by default", async () => {
    const files = await maintenanceFixture();
    const result = run(
      `install_maintenance_components "${process.cwd()}" "${files.environment}" "${files.systemd}" "${files.logrotate}"`,
      files,
    );

    expect(result.status, result.stderr).toBe(0);
    const log = await readFile(files.log, "utf8");
    expect(log).toContain(`install -d -m 0700 -o 1001 -g 1001 ${files.web}/inbox ${files.web}/uploads`);
    expect(log).toContain(`install -d -m 0750 -o 1001 -g 1001 ${files.web}/status`);
    expect(log).toContain(`install -d -m 0700 -o root -g root ${files.rootOps} ${files.rootOps}/prepared`);
    expect(log).toContain(`install -d -m 0750 -o root -g 1001 ${files.portable}`);
    expect(log).toContain("systemctl enable --now fitgridweb-maintenance.path");
    expect(log).not.toContain("enable --now fitgridweb-backup.timer");
    expect(log).not.toMatch(/sing-box|10256|30127/);
    expect(result.stdout).toContain("自动异机备份未启用：请配置并挂载 BACKUP_REMOTE_DIR");
  });

  it("installs fixed worker, timer, and root-only logrotate definitions", async () => {
    const files = await maintenanceFixture();
    expect(run(
      `install_maintenance_components "${process.cwd()}" "${files.environment}" "${files.systemd}" "${files.logrotate}"`,
      files,
    ).status).toBe(0);

    expect(await readFile(maintenancePathTemplate, "utf8"))
      .toContain("PathExistsGlob=/var/lib/fitgridweb/admin-ops/web/inbox/*.json");
    expect(await readFile(path.join(files.systemd, "fitgridweb-maintenance.path"), "utf8"))
      .toContain(`PathExistsGlob=${files.web}/inbox/*.json`);
    const service = await readFile(maintenanceServiceTemplate, "utf8");
    expect(service).toContain("Requires=docker.service");
    expect(service).toContain("ExecStart=/opt/fitgridweb/ops/maintenance-worker.sh");
    expect(service).toContain("UMask=0077");
    expect(service).not.toContain("fitgridweb.service");
    const timer = await readFile(backupTimerTemplate, "utf8");
    expect(timer).toContain("OnCalendar=*-*-* 02:30:00");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("RandomizedDelaySec=10m");
    expect(await readFile(path.join(files.systemd, "fitgridweb-backup.service"), "utf8"))
      .toBe(await readFile(backupServiceTemplate, "utf8"));
    expect(await readFile(logrotateTemplate, "utf8")).toContain("/var/lib/fitgridweb/admin-ops/root/audit.jsonl");
    expect(await readFile(files.logrotate, "utf8")).toContain(`${files.rootOps}/audit.jsonl`);
    expect((await stat(files.logrotate)).mode & 0o777).toBe(0o600);
    expect(await readFile(files.logrotate, "utf8")).toContain("rotate 180");
  });

  it("enables unattended backup only on a writable filesystem distinct from root", async () => {
    const files = await maintenanceFixture("configured");
    const command = `install_maintenance_components "${process.cwd()}" "${files.environment}" "${files.systemd}" "${files.logrotate}"`;

    expect(run(command, files, { REMOTE_DEVICE: "8:1" }).status).toBe(0);
    expect(await readFile(files.log, "utf8")).not.toContain("enable --now fitgridweb-backup.timer");

    await writeFile(files.log, "");
    expect(run(command, files, { REMOTE_DEVICE: "0:44" }).status).toBe(0);
    expect(await readFile(files.log, "utf8")).toContain("systemctl enable --now fitgridweb-backup.timer");
  });

  it("preserves existing history, prepared recovery state, and marker state on reinstall", async () => {
    const files = await maintenanceFixture();
    await mkdir(path.join(files.web, "status"), { recursive: true });
    await mkdir(path.join(files.rootOps, "prepared/existing"), { recursive: true });
    await writeFile(path.join(files.web, "status/backups.json"), '{"entries":[{"id":"keep"}]}\n');
    await writeFile(path.join(files.rootOps, "prepared/existing/database.dump"), "prepared-data");
    await writeFile(path.join(files.rootOps, "maintenance.json"), '{"schemaVersion":1,"active":true}\n');
    const command = `install_maintenance_components "${process.cwd()}" "${files.environment}" "${files.systemd}" "${files.logrotate}"`;

    expect(run(command, files).status).toBe(0);
    expect(run(command, files).status).toBe(0);
    expect(await readFile(path.join(files.web, "status/backups.json"), "utf8")).toContain('"id":"keep"');
    expect(await readFile(path.join(files.rootOps, "prepared/existing/database.dump"), "utf8")).toBe("prepared-data");
    expect(await readFile(path.join(files.rootOps, "maintenance.json"), "utf8")).toContain('"active":true');
  });

  it("rejects a root-only tree that overlaps the app-writable spool", async () => {
    const files = await maintenanceFixture();
    const unsafeEnvironment = (await readFile(files.environment, "utf8"))
      .replace(`ADMIN_OPS_ROOT_DIR=${files.rootOps}`, `ADMIN_OPS_ROOT_DIR=${files.web}/root`);
    await writeFile(files.environment, unsafeEnvironment);

    const result = run(
      `install_maintenance_components "${process.cwd()}" "${files.environment}" "${files.systemd}" "${files.logrotate}"`,
      files,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("不得重叠");
    await expect(readFile(files.log, "utf8")).rejects.toThrow();
  });

  it("normalizes only regular portable archives for the app reader group on upgrade", async () => {
    const files = await maintenanceFixture();
    await mkdir(files.portable, { recursive: true });
    const archive = path.join(files.portable, "fitgridweb-20260903T070000Z.fitgridbackup");
    const unrelated = path.join(files.portable, "notes.txt");
    const outside = path.join(files.root, "outside.fitgridbackup");
    const linked = path.join(files.portable, "fitgridweb-20260902T070000Z.fitgridbackup");
    await writeFile(archive, "archive");
    await chmod(archive, 0o600);
    await writeFile(unrelated, "keep");
    await writeFile(outside, "outside");
    await symlink(outside, linked);

    expect(run(
      `install_maintenance_components "${process.cwd()}" "${files.environment}" "${files.systemd}" "${files.logrotate}"`,
      files,
    ).status).toBe(0);
    const log = await readFile(files.log, "utf8");
    expect(log).toContain(`chown root:1001 ${archive}`);
    expect(log).not.toContain(`chown root:1001 ${linked}`);
    expect(log).not.toContain(unrelated);
    expect(log).not.toContain(outside);
    expect((await stat(archive)).mode & 0o777).toBe(0o640);
    expect(await readFile(outside, "utf8")).toBe("outside");
  });
});
