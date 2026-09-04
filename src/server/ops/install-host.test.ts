import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const library = path.join(process.cwd(), "ops/lib/install-host.sh");
const unitTemplate = path.join(process.cwd(), "ops/templates/fitgridweb.service");
const maintenancePathTemplate = path.join(process.cwd(), "ops/templates/fitgridweb-maintenance.path");
const maintenanceServiceTemplate = path.join(process.cwd(), "ops/templates/fitgridweb-maintenance.service");
const maintenanceRecoveryTemplate = path.join(process.cwd(), "ops/templates/fitgridweb-maintenance-recovery.service");
const maintenanceSweepTimerTemplate = path.join(process.cwd(), "ops/templates/fitgridweb-maintenance-sweep.timer");
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
  const ageBin = path.join(root, "usr-local-bin");
  const realSha256sum = spawnSync("sh", ["-c", "command -v sha256sum"], { encoding: "utf8" }).stdout.trim();
  await writeFile(swaps, swapKilobytes ? `Filename Type Size Used Priority\n/dev/existing partition ${swapKilobytes} 0 -2\n` : "Filename Type Size Used Priority\n");
  await writeFile(fstab, "UUID=root / ext4 defaults 0 1\n");
  await writeFile(release, "VERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n");
  await executable(bin, "fallocate", 'printf "fallocate %s\\n" "$*" >>"$COMMAND_LOG"; eval "target=\\${$#}"; : >"$target"');
  await executable(bin, "mkswap", 'printf "mkswap %s\\n" "$*" >>"$COMMAND_LOG"');
  await executable(bin, "swapon", 'printf "swapon %s\\n" "$*" >>"$COMMAND_LOG"');
  await executable(bin, "systemctl", `
printf 'systemctl %s\n' "$*" >>"$COMMAND_LOG"
case "$*" in
  "show --property=LoadState --value fitgridweb-backup.timer") printf 'loaded\n' ;;
  "show --property=UnitFileState --value fitgridweb-backup.timer") printf 'disabled\n' ;;
  "show --property=ActiveState --value fitgridweb-backup.timer") printf 'inactive\n' ;;
  "show --property=LoadState --value fitgridweb-backup.service") printf 'not-found\n' ;;
esac`);
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
  await executable(bin, "curl", `
printf 'curl %s\\n' "$*" >>"$COMMAND_LOG"
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -fsSLo) output=$2; shift 2 ;;
    http://*|https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
[ -n "$output" ] && [ -n "$url" ] || exit 1
case "$url" in
  *download.docker.com*) printf key >"$output" ;;
  *age-v1.3.2-linux-amd64.tar.gz)
    archive_root=$(mktemp -d)
    mkdir -p "$archive_root/age"
    printf '%s\\n' '#!/bin/sh' 'printf "v1.3.2\\n"' >"$archive_root/age/age"
    printf '%s\\n' '#!/bin/sh' 'printf "v1.3.2\\n"' >"$archive_root/age/age-plugin-batchpass"
    chmod 700 "$archive_root/age/age" "$archive_root/age/age-plugin-batchpass"
    /usr/bin/tar -czf "$output" -C "$archive_root" age
    rm -rf "$archive_root" ;;
  *) exit 1 ;;
esac`);
  await executable(bin, "sha256sum", `
printf 'sha256sum %s\\n' "$*" >>"$COMMAND_LOG"
if [ "$1" != -c ]; then exec "${realSha256sum}" "$@"; fi
[ "$1" = -c ] && [ "$2" = - ] || exit 2
IFS= read -r checksum_line
case "$checksum_line" in cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10'  '*) : ;; *) exit 3 ;; esac
[ "\${AGE_ARCHIVE_VALID:-1}" = 1 ] || exit 4`);
  await executable(bin, "flock", 'printf "flock %s\\n" "$*" >>"$COMMAND_LOG"');
  await executable(bin, "sync", 'printf "sync %s\\n" "$*" >>"$COMMAND_LOG"');
  return { root, bin, log, swaps, swapfile, fstab, aptRoot, release, unit, ageBin };
}

function run(command: string, files: Awaited<ReturnType<typeof fixture>>, env: Record<string, string> = {}) {
  return spawnSync("sh", ["-c", `. "${library}"; ${command}`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${files.bin}:${process.env.PATH}`, COMMAND_LOG: files.log, ...env },
  });
}

describe("host dependencies", () => {
  it("configures Docker's apt source and installs a pinned verified age batchpass pair", async () => {
    const files = await fixture();
    const command = `install_dependencies "${files.aptRoot}" "${files.release}" "${files.ageBin}"`;
    const result = run(command, files);
    expect(result.status, result.stderr).toBe(0);
    const source = await readFile(path.join(files.aptRoot, "sources.list.d/docker.sources"), "utf8");
    expect(source).toContain("https://download.docker.com/linux/ubuntu");
    expect(source).toContain("Suites: noble");
    const log = await readFile(files.log, "utf8");
    expect(log).toContain("docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin");
    expect(log).toContain("apt-get install -y --no-install-recommends jq util-linux");
    expect(log).not.toContain("apt-get install -y --no-install-recommends age ");
    expect(log).toContain(
      "curl -fsSLo ",
    );
    expect(log).toContain("https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz");
    expect(log).toContain("sha256sum -c -");
    expect((await stat(path.join(files.ageBin, "age"))).mode & 0o777).toBe(0o755);
    expect((await stat(path.join(files.ageBin, "age-plugin-batchpass"))).mode & 0o777).toBe(0o755);

    const second = run(command, files);
    expect(second.status, second.stderr).toBe(0);
    const secondLog = await readFile(files.log, "utf8");
    expect(secondLog.match(/age-v1\.3\.2-linux-amd64\.tar\.gz/g)).toHaveLength(1);
  });

  it("refuses to install age or its plugin when the release checksum fails", async () => {
    const files = await fixture();
    const result = run(
      `install_dependencies "${files.aptRoot}" "${files.release}" "${files.ageBin}"`,
      files,
      { AGE_ARCHIVE_VALID: "0" },
    );

    expect(result.status).not.toBe(0);
    await expect(stat(path.join(files.ageBin, "age"))).rejects.toThrow();
    await expect(stat(path.join(files.ageBin, "age-plugin-batchpass"))).rejects.toThrow();
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
    expect(source).toContain("Requires=fitgridweb-maintenance-recovery.service");
    expect(source).toMatch(/After=.*fitgridweb-maintenance-recovery\.service/);
    expect(source).toContain("docker-compose.low-memory.yml up --no-build -d --wait db app");
    expect(source).toContain("docker-compose.low-memory.yml stop app db");
    expect(source).not.toMatch(/caddy|sing-box|ufw|firewall/i);

    const files = await fixture();
    expect(run(`install_systemd_unit "${unitTemplate}" "${files.unit}"`, files).status).toBe(0);
    expect(await readFile(files.unit, "utf8")).toBe(source);
    const log = await readFile(files.log, "utf8");
    expect(log).toContain("systemctl daemon-reload");
    expect(log).not.toContain("systemctl enable fitgridweb.service");
  });

  it.each([
    ["cp", false],
    ["chmod", false],
    ["mv", false],
    ["daemon-reload", true],
  ])("stops unit installation and removes temporary data when %s fails", async (failureStage, installedBeforeFailure) => {
    const files = await fixture();
    await writeFile(files.unit, "legacy unit\n");
    const command = `
cp() {
  printf 'unit cp\\n' >>"$COMMAND_LOG"
  [ "$UNIT_FAILURE_STAGE" != cp ] || return 1
  command cp "$@"
}
chmod() {
  printf 'unit chmod\\n' >>"$COMMAND_LOG"
  [ "$UNIT_FAILURE_STAGE" != chmod ] || return 1
  command chmod "$@"
}
mv() {
  printf 'unit mv\\n' >>"$COMMAND_LOG"
  [ "$UNIT_FAILURE_STAGE" != mv ] || return 1
  command mv "$@"
}
systemctl() {
  printf 'systemctl %s\\n' "$*" >>"$COMMAND_LOG"
  [ "$UNIT_FAILURE_STAGE" != daemon-reload ] || [ "$1" != daemon-reload ]
}
install_systemd_unit "${unitTemplate}" "${files.unit}"
install_status=$?
[ "$install_status" -ne 0 ] || systemctl enable fitgridweb.service
exit "$install_status"
`;

    const result = run(command, files, { UNIT_FAILURE_STAGE: failureStage });

    expect(result.status).toBe(1);
    expect(await readFile(files.unit, "utf8")).toBe(
      installedBeforeFailure ? await readFile(unitTemplate, "utf8") : "legacy unit\n",
    );
    expect((await readdir(files.root)).filter((name) => name.startsWith("fitgridweb.service.tmp."))).toEqual([]);
    expect(await readFile(files.log, "utf8")).not.toContain("systemctl enable fitgridweb.service");
  });
});

describe("maintenance installation", () => {
  const validHistory = JSON.stringify({
    entries: [{
      id: ".id.ABC123",
      filename: "fitgridweb-20260903T070000Z.fitgridbackup",
      createdAt: "2026-09-03T07:00:00Z",
      size: 12345,
      sha256: "a".repeat(64),
      status: "ready",
    }],
  }) + "\n";

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

  it("installs private spool directories without enabling services before deployment", async () => {
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
    expect(log).toContain("systemctl daemon-reload");
    expect(log).not.toMatch(/systemctl (enable|disable)/);
    expect(log).not.toMatch(/sing-box|10256|30127/);
  });

  it("installs fixed maintenance workers without an automatic backup timer", async () => {
    const files = await maintenanceFixture();
    expect(run(
      `install_maintenance_components "${process.cwd()}" "${files.environment}" "${files.systemd}" "${files.logrotate}"`,
      files,
    ).status).toBe(0);

    expect(await readFile(maintenancePathTemplate, "utf8"))
      .toContain("PathExistsGlob=/var/lib/fitgridweb/admin-ops/web/inbox/*.json");
    expect(await readFile(maintenancePathTemplate, "utf8"))
      .toContain("PathExistsGlob=/var/lib/fitgridweb/admin-ops/web/inbox/*.audit");
    expect(await readFile(path.join(files.systemd, "fitgridweb-maintenance.path"), "utf8"))
      .toContain(`PathExistsGlob=${files.web}/inbox/*.json`);
    expect(await readFile(path.join(files.systemd, "fitgridweb-maintenance.path"), "utf8"))
      .toContain(`PathExistsGlob=${files.web}/inbox/*.audit`);
    const service = await readFile(maintenanceServiceTemplate, "utf8");
    expect(service).toContain("Requires=docker.service");
    expect(service).toContain("User=root\nGroup=root");
    expect(service).toContain("RuntimeDirectoryMode=0755");
    expect(service).toContain("ExecStart=/opt/fitgridweb/ops/maintenance-worker.sh");
    expect(service).toContain("UMask=0077");
    expect(service).not.toContain("fitgridweb.service");
    const recovery = await readFile(maintenanceRecoveryTemplate, "utf8");
    expect(recovery).toContain("Before=fitgridweb.service nginx.service");
    expect(recovery).toContain("User=root\nGroup=root");
    expect(recovery).toContain("RuntimeDirectoryMode=0755");
    expect(recovery).toContain(
      "ExecStartPre=/usr/bin/install -o root -g root -m 0644 /dev/null /run/fitgridweb/maintenance.flag",
    );
    expect(recovery).toContain("ExecStart=/opt/fitgridweb/ops/maintenance-worker.sh --recovery");
    expect(recovery).not.toMatch(/ConditionPathExists|PathExistsGlob/);
    const sweep = await readFile(maintenanceSweepTimerTemplate, "utf8");
    expect(sweep).toContain("OnUnitInactiveSec=1min");
    expect(sweep).toContain("Unit=fitgridweb-maintenance.service");
    await expect(readFile(path.join(files.systemd, "fitgridweb-backup.service"), "utf8"))
      .rejects.toThrow();
    await expect(readFile(path.join(files.systemd, "fitgridweb-backup.timer"), "utf8"))
      .rejects.toThrow();
    expect(await readFile(logrotateTemplate, "utf8")).toContain("/var/lib/fitgridweb/admin-ops/root/audit.jsonl");
    expect(await readFile(files.logrotate, "utf8")).toContain(`${files.rootOps}/audit.jsonl`);
    expect((await stat(files.logrotate)).mode & 0o777).toBe(0o600);
    expect(await readFile(files.logrotate, "utf8")).toContain("rotate 180");
  });

  it("disables the legacy unattended backup timer before maintenance installation", async () => {
    const files = await maintenanceFixture("configured");
    const command = `disable_legacy_backup_timer && install_maintenance_components "${process.cwd()}" "${files.environment}" "${files.systemd}" "${files.logrotate}" && enable_maintenance_components "${files.environment}"`;

    expect(run(command, files, { REMOTE_DEVICE: "8:1" }).status).toBe(0);
    const localLog = await readFile(files.log, "utf8");
    expect(localLog).toContain("systemctl enable --now fitgridweb-maintenance.path");
    expect(localLog).toContain("systemctl enable fitgridweb-maintenance-recovery.service");
    expect(localLog).toContain("systemctl start fitgridweb-maintenance-recovery.service");
    expect(localLog).toContain("systemctl enable --now fitgridweb-maintenance-sweep.timer");
    expect(localLog.indexOf("systemctl enable fitgridweb-maintenance-recovery.service"))
      .toBeLessThan(localLog.indexOf("systemctl start fitgridweb-maintenance-recovery.service"));
    expect(localLog.indexOf("systemctl start fitgridweb-maintenance-recovery.service"))
      .toBeLessThan(localLog.indexOf("systemctl enable --now fitgridweb-maintenance.path"));
    expect(localLog.indexOf("systemctl enable --now fitgridweb-maintenance.path"))
      .toBeLessThan(localLog.indexOf("systemctl enable --now fitgridweb-maintenance-sweep.timer"));
    expect(localLog).toContain("systemctl disable --now fitgridweb-backup.timer");
    expect(localLog.indexOf("systemctl disable --now fitgridweb-backup.timer"))
      .toBeLessThan(localLog.indexOf(`install -d -m 0700 -o 1001 -g 1001 ${files.web}`));
    expect(localLog).not.toContain("enable --now fitgridweb-backup.timer");

    await writeFile(files.log, "");
    expect(run(command, files, { REMOTE_DEVICE: "0:44" }).status).toBe(0);
    const remoteLog = await readFile(files.log, "utf8");
    expect(remoteLog).toContain("systemctl disable --now fitgridweb-backup.timer");
    expect(remoteLog).not.toContain("enable --now fitgridweb-backup.timer");
  });

  it("continues a fresh install when the legacy backup timer does not exist", async () => {
    const files = await maintenanceFixture();
    await executable(files.bin, "systemctl", `
printf 'systemctl %s\n' "$*" >>"$COMMAND_LOG"
case "$*" in
  "show --property=LoadState --value fitgridweb-backup.timer"|\
  "show --property=LoadState --value fitgridweb-backup.service") printf 'not-found\n' ;;
esac`);

    const result = run(
      `disable_legacy_backup_timer && install_maintenance_components "${process.cwd()}" "${files.environment}" "${files.systemd}" "${files.logrotate}" && enable_maintenance_components "${files.environment}"`,
      files,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(files.log, "utf8")).not.toContain(
      "systemctl disable --now fitgridweb-backup.timer",
    );
  });

  it("fails closed when querying a legacy unit load state fails", async () => {
    const files = await maintenanceFixture();
    await executable(files.bin, "systemctl", `
printf 'systemctl %s\n' "$*" >>"$COMMAND_LOG"
case "$*" in
  "show --property=LoadState --value fitgridweb-backup.timer") exit 5 ;;
esac`);

    const result = run("disable_legacy_backup_timer", files);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("旧版备份 unit 状态查询失败");
    expect(await readFile(files.log, "utf8")).not.toContain("systemctl disable --now");
  });

  it.each([
    ["disable command", "disable"],
    ["post-disable verification", "verify"],
  ])("fails closed when legacy timer %s fails", async (_caseName, failure) => {
    const files = await maintenanceFixture();
    await executable(files.bin, "systemctl", `
printf 'systemctl %s\n' "$*" >>"$COMMAND_LOG"
case "$*" in
  "show --property=LoadState --value fitgridweb-backup.timer") printf 'loaded\n' ;;
  "disable --now fitgridweb-backup.timer") [ "$FAILURE" != disable ] ;;
  "show --property=UnitFileState --value fitgridweb-backup.timer")
    [ "$FAILURE" != verify ] && printf 'disabled\n' || printf 'enabled\n' ;;
  "show --property=ActiveState --value fitgridweb-backup.timer") printf 'inactive\n' ;;
  "show --property=LoadState --value fitgridweb-backup.service") printf 'not-found\n' ;;
esac`,
    );

    const result = run("disable_legacy_backup_timer", files, { FAILURE: failure });

    expect(result.status).not.toBe(0);
  });

  it("stops a triggered legacy backup service and verifies it is inactive", async () => {
    const files = await maintenanceFixture();
    const activeMarker = path.join(files.root, "legacy-service-active");
    await writeFile(activeMarker, "");
    await executable(files.bin, "systemctl", `
printf 'systemctl %s\n' "$*" >>"$COMMAND_LOG"
case "$*" in
  "show --property=LoadState --value fitgridweb-backup.timer") printf 'loaded\n' ;;
  "disable --now fitgridweb-backup.timer") : ;;
  "show --property=UnitFileState --value fitgridweb-backup.timer") printf 'disabled\n' ;;
  "show --property=ActiveState --value fitgridweb-backup.timer") printf 'inactive\n' ;;
  "show --property=LoadState --value fitgridweb-backup.service") printf 'loaded\n' ;;
  "show --property=ActiveState --value fitgridweb-backup.service")
    [ -f "$ACTIVE_MARKER" ] && printf 'active\n' || printf 'inactive\n' ;;
  "stop fitgridweb-backup.service") rm -f "$ACTIVE_MARKER" ;;
esac`,
    );

    const result = run("disable_legacy_backup_timer", files, { ACTIVE_MARKER: activeMarker });

    expect(result.status, result.stderr).toBe(0);
    const log = await readFile(files.log, "utf8");
    expect(log).toContain("systemctl stop fitgridweb-backup.service");
    expect(log.match(/systemctl show --property=ActiveState --value fitgridweb-backup\.service/g))
      .toHaveLength(2);
  });

  it("preserves existing history, prepared recovery state, and marker state on reinstall", async () => {
    const files = await maintenanceFixture();
    await mkdir(path.join(files.web, "status"), { recursive: true });
    await mkdir(files.portable, { recursive: true });
    await mkdir(path.join(files.rootOps, "prepared/existing"), { recursive: true });
    const history = path.join(files.web, "status/backups.json");
    await writeFile(history, validHistory);
    await writeFile(path.join(files.portable, "fitgridweb-20260903T070000Z.fitgridbackup"), "archive");
    await chmod(history, 0o600);
    await writeFile(path.join(files.rootOps, "prepared/existing/database.dump"), "prepared-data");
    await writeFile(path.join(files.rootOps, "maintenance.json"), '{"schemaVersion":1,"active":true}\n');
    const command = `install_maintenance_components "${process.cwd()}" "${files.environment}" "${files.systemd}" "${files.logrotate}"`;

    expect(run(command, files).status).toBe(0);
    expect(run(command, files).status).toBe(0);
    expect(JSON.parse(await readFile(history, "utf8")).entries[0].id).toBe(".id.ABC123");
    expect((await stat(history)).mode & 0o777).toBe(0o640);
    expect(await readFile(files.log, "utf8")).toContain(`chown root:1001 ${history}`);
    expect(await readFile(path.join(files.rootOps, "prepared/existing/database.dump"), "utf8")).toBe("prepared-data");
    expect(await readFile(path.join(files.rootOps, "maintenance.json"), "utf8")).toContain('"active":true');
  });

  it("reconciles six crash-recovery entries before validating backup history", async () => {
    const files = await maintenanceFixture();
    await mkdir(path.join(files.web, "status"), { recursive: true });
    await mkdir(files.portable, { recursive: true });
    const filenames = [
      "fitgridweb-20260903T070000Z.fitgridbackup",
      "fitgridweb-20260902T070000Z.fitgridbackup",
      "fitgridweb-20260901T070000Z.fitgridbackup",
      "fitgridweb-20260831T070000Z.fitgridbackup",
      "fitgridweb-20260830T070000Z.fitgridbackup",
      "fitgridweb-20260829T070000Z.fitgridbackup",
    ];
    await Promise.all(filenames.map((filename) => writeFile(path.join(files.portable, filename), filename)));
    await writeFile(path.join(files.web, "status/backups.json"), JSON.stringify({
      entries: filenames.map((filename, index) => ({
        id: `.id.ABC12${index}`,
        filename,
        createdAt: `${filename.slice(11, 15)}-${filename.slice(15, 17)}-${filename.slice(17, 19)}T${filename.slice(20, 22)}:${filename.slice(22, 24)}:${filename.slice(24, 26)}Z`,
        size: filename.length,
        sha256: String(index).repeat(64),
        status: "ready",
      })),
    }) + "\n");

    const result = run(
      `install_maintenance_components "${process.cwd()}" "${files.environment}" "${files.systemd}" "${files.logrotate}"`,
      files,
    );

    expect(result.status, result.stderr).toBe(0);
    expect((await readdir(files.portable)).sort()).toEqual(filenames.slice(0, 5).sort());
    expect(JSON.parse(await readFile(path.join(files.web, "status/backups.json"), "utf8")).entries)
      .toHaveLength(5);
    expect(await readFile(files.log, "utf8")).toContain(`flock -w 30 9`);
  }, 15_000);

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

  it.each([
    ["ADMIN_OPS_WEB_DIR", "relative/admin-ops/web"],
    ["ADMIN_OPS_ROOT_DIR", "relative/admin-ops/root"],
    ["PORTABLE_BACKUP_DIR", "relative/portable-backups"],
    ["PORTABLE_BACKUP_HISTORY_FILE", "relative/admin-ops/web/status/backups.json"],
  ])("rejects relative %s before any host mutation", async (key, relativePath) => {
    const files = await maintenanceFixture();
    const configured = await readFile(files.environment, "utf8");
    await writeFile(
      files.environment,
      configured.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${relativePath}`),
    );

    const result = run(
      `install_maintenance_components "${process.cwd()}" "${files.environment}" "${files.systemd}" "${files.logrotate}"`,
      files,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${key} 不是安全的绝对路径`);
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

  it.each(["symlink", "directory", "invalid-json"])(
    "rejects an unsafe existing backups.json (%s)",
    async (kind) => {
      const files = await maintenanceFixture();
      const statusDirectory = path.join(files.web, "status");
      const history = path.join(statusDirectory, "backups.json");
      await mkdir(statusDirectory, { recursive: true });
      if (kind === "symlink") {
        const outside = path.join(files.root, "outside-history.json");
        await writeFile(outside, validHistory);
        await symlink(outside, history);
      } else if (kind === "directory") {
        await mkdir(history);
      } else {
        await writeFile(history, '{"entries":[{"id":"unsafe"}]}\n');
      }

      const result = run(
        `install_maintenance_components "${process.cwd()}" "${files.environment}" "${files.systemd}" "${files.logrotate}"`,
        files,
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("便携备份历史文件");
    },
  );
});
