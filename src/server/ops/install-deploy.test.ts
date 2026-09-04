import { chmod, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const library = path.join(process.cwd(), "ops/lib/install-deploy.sh");
const hostLibrary = path.join(process.cwd(), "ops/lib/install-host.sh");
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
  const environmentRestoreTemporary = path.join(root, "environment.rollback");
  const nginxTemporary = path.join(root, "nginx-temporary");
  const appUnit = path.join(root, "fitgridweb.service");
  const appUnitBackup = path.join(root, "fitgridweb.service.backup");
  const appUnitRestoreTemporary = path.join(root, "fitgridweb.service.restore");
  const unitState = path.join(root, "unit-state");
  await mkdir(nginxTemporary);
  await mkdir(path.join(unitState, "enabled"), { recursive: true });
  await mkdir(path.join(unitState, "active"), { recursive: true });
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
  *" pull db app"*)
    printf 'stage pull\\n' >>"$COMMAND_LOG"
    [ "\${FAIL_DEPLOY_STAGE:-}" != pull ] ;;
  *" up --no-build -d --wait db"*)
    printf 'stage db\\n' >>"$COMMAND_LOG"
    [ "\${FAIL_DEPLOY_STAGE:-}" != db ] ;;
  *"prisma migrate deploy"*)
    printf 'stage migration\\n' >>"$COMMAND_LOG"
    [ "\${FAIL_DEPLOY_STAGE:-}" != migration ] && [ "\${MIGRATION_OK:-1}" = 1 ] ;;
  *" up --no-build -d --wait app"*)
    if grep -Fq '${oldImage}' '${environment}'; then
      printf 'stage rollback-app\\n' >>"$COMMAND_LOG"
    else
      printf 'stage app\\n' >>"$COMMAND_LOG"
      [ "\${FAIL_DEPLOY_STAGE:-}" != app ]
    fi ;;
  *) exit 0 ;;
esac`);
  await executable(bin, "curl", `
printf 'curl %s\\n' "$*" >>"$COMMAND_LOG"
printf 'stage health\\n' >>"$COMMAND_LOG"
[ "\${FAIL_DEPLOY_STAGE:-}" != health ] && [ "\${HEALTH_OK:-1}" = 1 ]`);
  await executable(bin, "systemctl", `
printf 'systemctl %s\\n' "$*" >>"$COMMAND_LOG"
[ -n "\${UNIT_STATE_DIRECTORY:-}" ] || exit 0
action=$1
shift
unit=
start_now=false
for argument do
  case $argument in --now) start_now=true ;; --*) : ;; *) unit=$argument ;; esac
done
case $action in
  is-enabled) [ -f "$UNIT_STATE_DIRECTORY/enabled/$unit" ]; exit ;;
  is-active) [ -f "$UNIT_STATE_DIRECTORY/active/$unit" ]; exit ;;
  enable)
    : >"$UNIT_STATE_DIRECTORY/enabled/$unit"
    [ "$start_now" = false ] || : >"$UNIT_STATE_DIRECTORY/active/$unit" ;;
  disable)
    rm -f "$UNIT_STATE_DIRECTORY/enabled/$unit"
    [ "$start_now" = false ] || rm -f "$UNIT_STATE_DIRECTORY/active/$unit" ;;
  start) : >"$UNIT_STATE_DIRECTORY/active/$unit" ;;
  stop)
    if [ "$unit" != fitgridweb.service ] || [ "\${FAIL_APP_STOP:-0}" != 1 ]; then
      rm -f "$UNIT_STATE_DIRECTORY/active/$unit"
    fi ;;
  restart)
    if [ "\${FAIL_ACTIVATION_STAGE:-}" = app-restart ]; then
      rm -f "$UNIT_STATE_DIRECTORY/active/$unit"
    else
      : >"$UNIT_STATE_DIRECTORY/active/$unit"
    fi ;;
  *) exit 0 ;;
esac
failure_stage=
case "$action:$unit" in
  start:fitgridweb-maintenance-recovery.service) failure_stage=recovery ;;
  enable:fitgridweb-maintenance.path) failure_stage=path ;;
  enable:fitgridweb-maintenance-sweep.timer) failure_stage=sweep ;;
  disable:fitgridweb-backup.timer) failure_stage=backup ;;
  enable:fitgridweb.service) failure_stage=app-enable ;;
  restart:fitgridweb.service) failure_stage=app-restart ;;
esac
[ "$action:$unit" != stop:fitgridweb.service ] || [ "\${FAIL_APP_STOP:-0}" != 1 ] || exit 1
[ -z "$failure_stage" ] || [ "\${FAIL_ACTIVATION_STAGE:-}" != "$failure_stage" ]`);
  await executable(bin, "sleep", ":");
  return {
    root, bin, project, environment, oldEnvironment, environmentBackup, environmentRestoreTemporary, nginxTemporary,
    appUnit, appUnitBackup, appUnitRestoreTemporary, unitState, log,
  };
}

function run(command: string, files: Awaited<ReturnType<typeof fixture>>, env: Record<string, string> = {}) {
  return spawnSync("sh", ["-c", `. "${hostLibrary}"; . "${library}"; ${command}`], {
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

function installLifecycleCommand(files: Awaited<ReturnType<typeof fixture>>, upgrade: boolean) {
  const sha = "2ca7f41000000000000000000000000000000000";
  return `
validate_domain() { :; }
validate_port() { :; }
validate_nginx_site() { :; }
image_for_sha() { printf 'unused\\n'; }
assert_public_image() { :; }
install_dependencies() { :; }
assert_app_port_available() { :; }
mkdir() { :; }
mktemp() {
  case "\${1:-}" in
    -d) printf '%s\\n' "${files.nginxTemporary}" ;;
    "${files.appUnit}.tmp."*) printf '%s\\n' "${files.appUnitRestoreTemporary}" ;;
    "${files.environment}.rollback."*)
      [ "\${FAIL_ENVIRONMENT_RESTORE:-0}" != 1 ] || return 1
      printf '%s\\n' "${files.environmentRestoreTemporary}" ;;
    *fitgridweb.service*) printf '%s\\n' "${files.appUnitBackup}" ;;
    *) printf '%s\\n' "${files.environmentBackup}" ;;
  esac
}
cp() {
  if [ "\${FAIL_UNIT_RESTORE_STAGE:-}" = cp ] \
    && [ "\${1:-}" = "${files.appUnitBackup}" ] \
    && [ "\${2:-}" = "${files.appUnitRestoreTemporary}" ]; then
    return 1
  fi
  command cp "$@"
}
mv() {
  if [ "\${FAIL_UNIT_RESTORE_STAGE:-}" = mv ] \
    && [ "\${1:-}" = "${files.appUnitRestoreTemporary}" ] \
    && [ "\${2:-}" = "${files.appUnit}" ]; then
    return 1
  fi
  command mv "$@"
}
ensure_environment() {
  printf 'APP_IMAGE=${newImage}\\nPORTABLE_BACKUP_MAX_BYTES=536870912\\nBACKUP_REMOTE_DIR=${files.root}/remote\\n' >"$1"
}
ensure_swap() { :; }
install_maintenance_components() { printf 'phase install-maintenance\\n' >>"$COMMAND_LOG"; }
deploy_release() { printf 'phase deploy\\n' >>"$COMMAND_LOG"; }
render_nginx_snippet() { printf 'location /fitgrid {}\\n'; }
install_nginx_include() { :; }
test_public_health_count=0
verify_health() {
  test_public_health_count=$((test_public_health_count + 1))
  printf 'phase public-health\\n' >>"$COMMAND_LOG"
  [ "\${FAIL_ACTIVATION_STAGE:-}" != final-health ] || [ "$test_public_health_count" -ne 2 ]
}
install_systemd_unit() {
  printf 'phase app-unit-install\\n' >>"$COMMAND_LOG"
  printf 'new app unit\\n' >"$APP_UNIT_FIXTURE"
  systemctl daemon-reload
  [ "\${FAIL_ACTIVATION_STAGE:-}" != app-install ]
}
cleanup_old_app_images() { :; }
test_daemon_reload_count=0
systemctl() {
  if [ "\${1:-}" = daemon-reload ]; then
    test_daemon_reload_count=$((test_daemon_reload_count + 1))
    command systemctl "$@" || return 1
    [ "\${FAIL_UNIT_RESTORE_STAGE:-}" != daemon ] || [ "$test_daemon_reload_count" -ne 2 ]
    return $?
  fi
  if [ "\${1:-}" = start ] && [ "\${2:-}" = fitgridweb.service ]; then
    if grep -Fq '${oldImage}' '${files.environment}'; then app_environment=old; else app_environment=new; fi
    if grep -Fq 'legacy app unit' "$APP_UNIT_FIXTURE"; then app_unit=legacy; else app_unit=new; fi
    printf 'phase app-state-start env=%s unit=%s\\n' "$app_environment" "$app_unit" >>"$COMMAND_LOG"
  fi
  command systemctl "$@"
}
fitgrid_install_main grid.example.com 3300 443 /etc/nginx/conf.d/fitgridweb.conf \\
  ${sha} no no ${String(upgrade)} "${files.project}" "${files.environment}" "${files.root}/backup.key" "${files.appUnit}"
`;
}

describe("deployment state machine", () => {
  it.each([
    ["mktemp", ["restore mktemp"]],
    ["cp", ["restore mktemp", "restore cp", "restore rm"]],
    ["chmod", ["restore mktemp", "restore cp", "restore chmod", "restore rm"]],
    ["mv", ["restore mktemp", "restore cp", "restore chmod", "restore mv", "restore rm"]],
  ])("keeps the current environment and removes temporary data when restore %s fails", async (failureStage, expectedLog) => {
    const files = await fixture();
    const command = `
mktemp() {
  printf 'restore mktemp\\n' >>"$COMMAND_LOG"
  [ "$RESTORE_FAILURE_STAGE" != mktemp ] || return 1
  command mktemp "$@"
}
cp() {
  printf 'restore cp\\n' >>"$COMMAND_LOG"
  [ "$RESTORE_FAILURE_STAGE" != cp ] || return 1
  command cp "$@"
}
chmod() {
  printf 'restore chmod\\n' >>"$COMMAND_LOG"
  [ "$RESTORE_FAILURE_STAGE" != chmod ] || return 1
  command chmod "$@"
}
mv() {
  printf 'restore mv\\n' >>"$COMMAND_LOG"
  [ "$RESTORE_FAILURE_STAGE" != mv ] || return 1
  command mv "$@"
}
rm() {
  printf 'restore rm\\n' >>"$COMMAND_LOG"
  command rm "$@"
}
restore_environment "${files.environment}" "${files.oldEnvironment}"
`;

    const result = run(command, files, { RESTORE_FAILURE_STAGE: failureStage });

    expect(result.status).toBe(1);
    expect(await readFile(files.environment, "utf8")).toContain(`APP_IMAGE=${newImage}`);
    expect((await readdir(files.root)).filter((name) => name.startsWith("fitgridweb.env.rollback."))).toEqual([]);
    expect((await readFile(files.log, "utf8")).trim().split("\n")).toEqual(expectedLog);
  });

  it("restores only unit states changed after the activation snapshot", async () => {
    const files = await fixture();
    const appUnitName = "fitgridweb.service";
    const pathUnitName = "fitgridweb-maintenance.path";
    const backupTimerName = "fitgridweb-backup.timer";
    await writeFile(path.join(files.unitState, "enabled", appUnitName), "");
    await writeFile(path.join(files.unitState, "active", appUnitName), "");
    await writeFile(path.join(files.unitState, "enabled", pathUnitName), "");
    await writeFile(path.join(files.unitState, "active", pathUnitName), "");
    await writeFile(path.join(files.unitState, "enabled", backupTimerName), "");
    await writeFile(path.join(files.unitState, "active", backupTimerName), "");
    const command = `
saved_states=$(capture_fitgrid_unit_states)
systemctl enable fitgridweb-maintenance-recovery.service
systemctl start fitgridweb-maintenance-recovery.service
systemctl enable --now fitgridweb-maintenance.path
systemctl enable --now fitgridweb-maintenance-sweep.timer
    systemctl disable --now fitgridweb-backup.timer
systemctl enable fitgridweb.service
printf 'restore-boundary\\n' >>"$COMMAND_LOG"
restore_fitgrid_unit_states "$saved_states"
`;

    const result = run(command, files, { UNIT_STATE_DIRECTORY: files.unitState });

    expect(result.status, result.stderr).toBe(0);
    expect((await readdir(path.join(files.unitState, "enabled"))).sort())
      .toEqual([backupTimerName, pathUnitName, appUnitName].sort());
    expect((await readdir(path.join(files.unitState, "active"))).sort())
      .toEqual([backupTimerName, pathUnitName, appUnitName].sort());
    const log = await readFile(files.log, "utf8");
    const restoreLog = log.slice(log.indexOf("restore-boundary"));
    expect(restoreLog).not.toMatch(/(?:disable|stop) (?:fitgridweb\.service|fitgridweb-maintenance\.path)/);
  });

  it.each([
    ["legacy unit", true],
    ["fresh install", false],
  ])("restores the %s bytes after a failed app-unit install", async (_caseName, hadPreviousUnit) => {
    const files = await fixture();
    if (hadPreviousUnit) await writeFile(files.appUnitBackup, "legacy app unit\n");
    await writeFile(files.appUnit, "partially installed new unit\n");

    const result = run(
      `restore_fitgrid_systemd_unit "${files.appUnit}" "${files.appUnitBackup}" ${String(hadPreviousUnit)}`,
      files,
    );

    expect(result.status, result.stderr).toBe(0);
    if (hadPreviousUnit) {
      expect(await readFile(files.appUnit, "utf8")).toBe("legacy app unit\n");
    } else {
      await expect(readFile(files.appUnit, "utf8")).rejects.toThrow();
    }
  });

  it.each([
    ["recovery", false],
    ["path", false],
    ["sweep", false],
    ["app-install", false],
    ["app-enable", false],
    ["app-restart", true],
    ["final-health", true],
  ])(
    "removes fresh unit activation state when %s activation fails",
    async (failureStage, restarted) => {
      const files = await fixture();
      await unlink(files.environment);

      const result = run(installLifecycleCommand(files, false), files, {
        APP_UNIT_FIXTURE: files.appUnit,
        FAIL_ACTIVATION_STAGE: failureStage,
        UNIT_STATE_DIRECTORY: files.unitState,
      });

      expect(result.status).toBe(1);
      await expect(readFile(files.environment, "utf8")).rejects.toThrow();
      await expect(readFile(files.appUnit, "utf8")).rejects.toThrow();
      expect(await readdir(path.join(files.unitState, "enabled"))).toEqual([]);
      expect(await readdir(path.join(files.unitState, "active"))).toEqual([]);
      expect((await readFile(files.log, "utf8")).includes("systemctl restart fitgridweb.service")).toBe(restarted);
    },
  );

  it("fails an upgrade if an active legacy backup timer cannot be disabled", async () => {
    const files = await fixture();
    const backupTimerName = "fitgridweb-backup.timer";
    await writeFile(path.join(files.unitState, "enabled", backupTimerName), "");
    await writeFile(path.join(files.unitState, "active", backupTimerName), "");

    const result = run(installLifecycleCommand(files, true), files, {
      APP_UNIT_FIXTURE: files.appUnit,
      FAIL_ACTIVATION_STAGE: "backup",
      UNIT_STATE_DIRECTORY: files.unitState,
    });

    expect(result.status).toBe(1);
    expect(await readdir(path.join(files.unitState, "enabled"))).toContain(backupTimerName);
    expect(await readdir(path.join(files.unitState, "active"))).toContain(backupTimerName);
  });

  it("restores the legacy environment before restarting its previously active app", async () => {
    const files = await fixture();
    const appUnitName = "fitgridweb.service";
    await writeFile(files.environment, await readFile(files.oldEnvironment, "utf8"));
    await writeFile(files.appUnit, "legacy app unit\n");
    await writeFile(path.join(files.unitState, "enabled", appUnitName), "");
    await writeFile(path.join(files.unitState, "active", appUnitName), "");

    const result = run(installLifecycleCommand(files, true), files, {
      APP_UNIT_FIXTURE: files.appUnit,
      FAIL_ACTIVATION_STAGE: "app-restart",
      UNIT_STATE_DIRECTORY: files.unitState,
    });

    expect(result.status).toBe(1);
    expect(await readFile(files.environment, "utf8")).toContain(`APP_IMAGE=${oldImage}`);
    expect(await readFile(files.appUnit, "utf8")).toBe("legacy app unit\n");
    expect(await readdir(path.join(files.unitState, "enabled"))).toEqual([appUnitName]);
    expect(await readdir(path.join(files.unitState, "active"))).toEqual([appUnitName]);
    const log = await readFile(files.log, "utf8");
    const restart = log.indexOf("systemctl restart fitgridweb.service");
    const restoreUnit = log.indexOf("systemctl daemon-reload", restart);
    const restoreState = log.indexOf("phase app-state-start env=old unit=legacy", restoreUnit);
    const restoreApp = log.indexOf("stage rollback-app", restoreState);
    expect(restart).toBeGreaterThan(-1);
    expect(restoreUnit).toBeGreaterThan(restart);
    expect(restoreState).toBeGreaterThan(restoreUnit);
    expect(restoreApp).toBeGreaterThan(restoreState);
  });

  it("does not restart a previously active app when its old environment cannot be restored", async () => {
    const files = await fixture();
    const appUnitName = "fitgridweb.service";
    await writeFile(files.environment, await readFile(files.oldEnvironment, "utf8"));
    await writeFile(files.appUnit, "legacy app unit\n");
    await writeFile(path.join(files.unitState, "enabled", appUnitName), "");
    await writeFile(path.join(files.unitState, "active", appUnitName), "");

    const result = run(installLifecycleCommand(files, true), files, {
      APP_UNIT_FIXTURE: files.appUnit,
      FAIL_ACTIVATION_STAGE: "app-restart",
      FAIL_ENVIRONMENT_RESTORE: "1",
      UNIT_STATE_DIRECTORY: files.unitState,
    });

    expect(result.status).toBe(1);
    await expect(readFile(files.environment, "utf8")).rejects.toThrow();
    expect(await readFile(files.appUnit, "utf8")).toBe("legacy app unit\n");
    expect(await readdir(path.join(files.unitState, "enabled"))).toEqual([appUnitName]);
    expect(await readdir(path.join(files.unitState, "active"))).toEqual([]);
    const log = await readFile(files.log, "utf8");
    expect(log).not.toContain("phase app-state-start");
    expect(log).toContain("docker compose --project-name fitgridweb");
    expect(log).toContain("stop app");
  });

  it.each([
    ["cp", "app-restart", false, "new app unit\n"],
    ["mv", "app-restart", false, "new app unit\n"],
    ["daemon", "app-restart", false, "legacy app unit\n"],
    ["daemon", "final-health", false, "legacy app unit\n"],
    ["daemon", "final-health", true, "legacy app unit\n"],
  ])(
    "stops the app and suppresses state restart when unit restore %s fails after %s (stop failure: %s)",
    async (restoreFailure, activationFailure, stopFails, expectedUnit) => {
      const files = await fixture();
      const appUnitName = "fitgridweb.service";
      await writeFile(files.environment, await readFile(files.oldEnvironment, "utf8"));
      await writeFile(files.appUnit, "legacy app unit\n");
      await writeFile(path.join(files.unitState, "enabled", appUnitName), "");
      await writeFile(path.join(files.unitState, "active", appUnitName), "");

      const result = run(installLifecycleCommand(files, true), files, {
        APP_UNIT_FIXTURE: files.appUnit,
        FAIL_ACTIVATION_STAGE: activationFailure,
        FAIL_APP_STOP: stopFails ? "1" : "0",
        FAIL_UNIT_RESTORE_STAGE: restoreFailure,
        UNIT_STATE_DIRECTORY: files.unitState,
      });

      expect(result.status).toBe(1);
      expect(await readFile(files.environment, "utf8")).toContain(`APP_IMAGE=${oldImage}`);
      expect(await readFile(files.appUnit, "utf8")).toBe(expectedUnit);
      expect(await readdir(path.join(files.unitState, "enabled"))).toEqual([appUnitName]);
      expect(await readdir(path.join(files.unitState, "active"))).toEqual(stopFails ? [appUnitName] : []);
      const log = await readFile(files.log, "utf8");
      const firstPublicHealth = log.indexOf("phase public-health");
      const activationFailurePoint = activationFailure === "final-health"
        ? log.indexOf("phase public-health", firstPublicHealth + 1)
        : log.indexOf("systemctl restart fitgridweb.service");
      const stop = log.indexOf("systemctl stop fitgridweb.service", activationFailurePoint);
      const restoreApp = log.indexOf("stage rollback-app", stop);
      expect(stop).toBeGreaterThan(activationFailurePoint);
      expect(restoreApp).toBeGreaterThan(stop);
      expect(log).not.toContain("phase app-state-start");
      if (stopFails) expect(result.stderr).toContain("systemd 应用服务停止失败；请立即人工检查");
    },
  );

  it("restores a legacy app unit and preserves its prior service state when app enable fails", async () => {
    const files = await fixture();
    const appUnitName = "fitgridweb.service";
    await writeFile(files.environment, await readFile(files.oldEnvironment, "utf8"));
    await writeFile(files.appUnit, "legacy app unit\n");
    await writeFile(path.join(files.unitState, "enabled", appUnitName), "");
    await writeFile(path.join(files.unitState, "active", appUnitName), "");

    const result = run(installLifecycleCommand(files, true), files, {
      APP_UNIT_FIXTURE: files.appUnit,
      FAIL_ACTIVATION_STAGE: "app-enable",
      UNIT_STATE_DIRECTORY: files.unitState,
    });

    expect(result.status).toBe(1);
    expect(await readFile(files.environment, "utf8")).toContain(`APP_IMAGE=${oldImage}`);
    expect(await readFile(files.appUnit, "utf8")).toBe("legacy app unit\n");
    expect(await readdir(path.join(files.unitState, "enabled"))).toEqual([appUnitName]);
    expect(await readdir(path.join(files.unitState, "active"))).toEqual([appUnitName]);
    const log = await readFile(files.log, "utf8");
    expect(log).not.toContain("systemctl disable fitgridweb.service");
    expect(log).not.toContain("systemctl stop fitgridweb.service");
    const restoreUnit = log.lastIndexOf("systemctl daemon-reload");
    const restoreStates = log.indexOf("systemctl stop fitgridweb-maintenance-recovery.service", restoreUnit);
    const restoreOldApp = log.indexOf("stage rollback-app", restoreStates);
    expect(restoreUnit).toBeGreaterThan(-1);
    expect(restoreStates).toBeGreaterThan(restoreUnit);
    expect(restoreOldApp).toBeGreaterThan(restoreStates);
  });

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
capture_fitgrid_unit_states() { printf 'saved-unit-state\\n'; }
enable_maintenance_components() {
  printf 'phase recovery-start\\nphase path-start\\nphase sweep-start\\nphase backup-start\\n' >>"$COMMAND_LOG"
}
install_systemd_unit() { printf 'phase app-unit-install\\n' >>"$COMMAND_LOG"; }
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
    expect(phases).toEqual([
      "phase install-maintenance",
      "phase start-app",
      "phase health",
      "phase recovery-start",
      "phase path-start",
      "phase sweep-start",
      "phase backup-start",
      "phase app-unit-install",
      "phase enable fitgridweb.service",
      "phase restart fitgridweb.service",
      "phase health",
    ]);
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
  case "\${1:-}" in
    -d) printf '%s\\n' "${files.nginxTemporary}" ;;
    "${files.environment}.rollback."*) printf '%s\\n' "${files.environmentRestoreTemporary}" ;;
    *) printf '%s\\n' "${files.environmentBackup}" ;;
  esac
}
ensure_environment() { printf 'APP_IMAGE=${newImage}\\nPORTABLE_BACKUP_MAX_BYTES=536870912\\n' >"$1"; }
ensure_swap() { :; }
deploy_release() { printf 'phase deploy\\n' >>"$COMMAND_LOG"; }
render_nginx_snippet() { printf 'location /fitgrid {}\\n'; }
install_nginx_include() { :; }
verify_health() { printf 'phase health\\n' >>"$COMMAND_LOG"; }
install_systemd_unit() { :; }
systemctl() { printf 'phase restart-systemd\\n' >>"$COMMAND_LOG"; }
capture_fitgrid_unit_states() { printf 'saved-unit-state\\n'; }
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

  it("does not enable the app after public health fails", async () => {
    const files = await fixture();
    await unlink(files.environment);
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
capture_fitgrid_unit_states() { printf 'saved-unit-state\\n'; }
deploy_release() { printf 'phase deploy\\n' >>"$COMMAND_LOG"; }
render_nginx_snippet() { printf 'location /fitgrid {}\\n'; }
install_nginx_include() { :; }
verify_health() { printf 'phase health\\n' >>"$COMMAND_LOG"; return 1; }
systemctl() { printf 'phase %s\\n' "$*" >>"$COMMAND_LOG"; }
cleanup_old_app_images() { :; }
fitgrid_install_main grid.example.com 3300 443 /etc/nginx/conf.d/fitgridweb.conf \\
  ${sha} no no false "${files.project}" "${files.environment}" "${files.root}/backup.key"
`;

    const result = run(command, files);

    expect(result.status).toBe(1);
    await expect(readFile(files.environment, "utf8")).rejects.toThrow();
    const log = await readFile(files.log, "utf8");
    expect(log).not.toContain("enable fitgridweb.service");
  });

  it.each([
    ["environment source", "source", ["stage rollback-app"]],
    ["image pull", "pull", ["stage pull", "stage rollback-app"]],
    ["database startup", "db", ["stage pull", "stage db", "stage rollback-app"]],
    ["migration", "migration", ["stage pull", "stage db", "stage migration", "stage rollback-app"]],
    ["application startup", "app", ["stage pull", "stage db", "stage migration", "stage app", "stage rollback-app"]],
    ["loopback health", "health", ["stage pull", "stage db", "stage migration", "stage app", "stage health", "stage rollback-app"]],
  ])("stops deployment and restores the old app when %s fails", async (_caseName, failureStage, expectedStages) => {
    const files = await fixture();
    if (failureStage === "source") await writeFile(files.environment, `${await readFile(files.environment, "utf8")}false\n`);

    const result = run(
      `deploy_release "${files.project}" "${files.environment}" "${files.oldEnvironment}" 3300`,
      files,
      { FAIL_DEPLOY_STAGE: failureStage },
    );

    expect(result.status).toBe(1);
    expect(await readFile(files.environment, "utf8")).toContain(`APP_IMAGE=${oldImage}`);
    const stages = (await readFile(files.log, "utf8")).split("\n").filter((line) => line.startsWith("stage "));
    expect(stages).toEqual(expectedStages);
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

});
