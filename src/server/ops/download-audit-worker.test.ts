import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const projectDirectory = process.cwd();
const AUDIT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const BACKUP_ID = "backup-20260903";
const REQUEST_ID = "request_admin_download_0001";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "fitgrid-download-audit-worker-")));
  roots.push(root);
  const web = path.join(root, "web");
  const rootOps = path.join(root, "root");
  const portable = path.join(root, "portable");
  const inbox = path.join(web, "inbox");
  const status = path.join(web, "status");
  await Promise.all([
    mkdir(inbox, { recursive: true, mode: 0o700 }),
    mkdir(status, { recursive: true, mode: 0o750 }),
    mkdir(rootOps, { recursive: true, mode: 0o700 }),
    mkdir(portable, { recursive: true, mode: 0o700 }),
  ]);
  const request = path.join(inbox, `${AUDIT_ID}.audit`);
  const acknowledgment = path.join(status, `${AUDIT_ID}.audit`);
  const commandLog = path.join(root, "commands.log");
  return { root, web, rootOps, portable, request, acknowledgment, commandLog };
}

async function publishRequest(request: string, extra: Record<string, unknown> = {}) {
  await writeFile(request, `${JSON.stringify({
    schemaVersion: 1,
    id: AUDIT_ID,
    event: "download-token-issued",
    actorId: ADMIN_ID,
    requestId: REQUEST_ID,
    backupId: BACKUP_ID,
    ...extra,
  })}\n`, { mode: 0o600 });
  await chmod(request, 0o600);
}

function runWorker(files: Awaited<ReturnType<typeof fixture>>) {
  const result = spawnSync("sh", ["-c", `
. "${projectDirectory}/ops/lib/portable-backup.sh"
. "${projectDirectory}/ops/lib/maintenance-jobs.sh"
. "${projectDirectory}/ops/lib/download-audit.sh"
maintenance_root_uid() { id -u; }
maintenance_root_gid() { id -g; }
maintenance_normalize_root_file() { chmod "$2" "$1"; }
maintenance_publish_public_file() {
  printf 'publish:%s\\n' "$1" >>"$COMMAND_LOG"
  chmod 640 "$1"
}
portable_sync_filesystem() {
  printf 'sync:%s\\n' "$1" >>"$COMMAND_LOG"
}
download_audit_prepare_directories
download_audit_drain
`], {
    cwd: projectDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      ADMIN_OPS_DIR: files.web,
      ADMIN_OPS_ROOT_DIR: files.rootOps,
      PORTABLE_BACKUP_DIR: files.portable,
      PORTABLE_BACKUP_READER_GID: String(process.getgid?.() ?? 1001),
      COMMAND_LOG: files.commandLog,
    },
  });
  return result;
}

describe("root download audit worker", () => {
  it("persists the fixed redacted audit before acknowledging it to the app", async () => {
    const files = await fixture();
    await publishRequest(files.request);

    const result = runWorker(files);

    expect(result.status, result.stderr).toBe(0);
    const lines = (await readFile(path.join(files.rootOps, "audit.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      operation: "download-token",
      auditId: AUDIT_ID,
      actorId: ADMIN_ID,
      requestId: REQUEST_ID,
      backupId: BACKUP_ID,
      status: "issued",
    });
    expect(Object.keys(lines[0]).sort()).toEqual([
      "actorId",
      "auditId",
      "backupId",
      "operation",
      "requestId",
      "status",
      "time",
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/token-for|passphrase|private\/host/);
    expect(JSON.parse(await readFile(files.acknowledgment, "utf8"))).toEqual({
      schemaVersion: 1,
      id: AUDIT_ID,
      state: "persisted",
    });
    await expect(readFile(files.request, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const log = await readFile(files.commandLog, "utf8");
    expect(log.indexOf(`sync:${files.rootOps}/audit.jsonl`))
      .toBeLessThan(log.indexOf(`publish:${files.web}/status/.${AUDIT_ID}.`));
  });

  it("replays an acknowledged-boundary crash without duplicating root audit", async () => {
    const files = await fixture();
    await publishRequest(files.request);
    expect(runWorker(files).status).toBe(0);
    await unlink(files.acknowledgment);
    await publishRequest(files.request);

    const replay = runWorker(files);

    expect(replay.status, replay.stderr).toBe(0);
    const lines = (await readFile(path.join(files.rootOps, "audit.jsonl"), "utf8"))
      .trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(await readFile(files.acknowledgment, "utf8"))).toMatchObject({
      id: AUDIT_ID,
      state: "persisted",
    });
  });

  it("rejects an event with extra secret-bearing fields without acknowledging it", async () => {
    const files = await fixture();
    await publishRequest(files.request, { token: "must-never-reach-root-audit" });

    const result = runWorker(files);

    expect(result.status).not.toBe(0);
    await expect(readFile(files.acknowledgment, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const auditPath = path.join(files.rootOps, "audit.jsonl");
    await expect(readFile(auditPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.join(files.rootOps, "download-audit-claimed"))).toEqual([]);
  });
});
