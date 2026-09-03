import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileMaintenanceGateway } from "./file-maintenance-gateway";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const JOB_A = "22222222-2222-4222-8222-222222222222";
const JOB_B = "33333333-3333-4333-8333-333333333333";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  ids: string[] = [JOB_A, JOB_B],
  overrides: Record<string, unknown> = {},
) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "fitgrid-gateway-")));
  roots.push(root);
  const adminOpsDirectory = path.join(root, "admin-ops");
  const portableBackupDirectory = path.join(root, "portable-backups");
  const portableBackupHistoryFile = path.join(adminOpsDirectory, "status", "backups.json");
  for (const directory of [
    path.join(adminOpsDirectory, "inbox"),
    path.join(adminOpsDirectory, "uploads"),
    path.join(adminOpsDirectory, "status"),
    portableBackupDirectory,
  ]) await mkdir(directory, { recursive: true });

  let index = 0;
  const gateway = new FileMaintenanceGateway({
    adminOpsDirectory,
    portableBackupDirectory,
    portableBackupHistoryFile,
    maxUploadBytes: 128,
    idGenerator: () => ids[index++] ?? randomUUID(),
    ...overrides,
  });

  return {
    root,
    adminOpsDirectory,
    portableBackupDirectory,
    portableBackupHistoryFile,
    gateway,
    async job(id: string) {
      return JSON.parse(await readFile(path.join(adminOpsDirectory, "inbox", `${id}.json`), "utf8"));
    },
    async publicFiles() {
      const names = [
        ...(await readdir(path.join(adminOpsDirectory, "inbox"))),
        ...(await readdir(path.join(adminOpsDirectory, "status"))),
      ];
      const contents: string[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const candidates = [
          path.join(adminOpsDirectory, "inbox", name),
          path.join(adminOpsDirectory, "status", name),
        ];
        for (const candidate of candidates) {
          if ((await lstat(candidate).catch(() => null))?.isFile()) {
            contents.push(await readFile(candidate, "utf8"));
          }
        }
      }
      return contents;
    },
  };
}

describe("FileMaintenanceGateway", () => {
  it("accepts a linked job when directory fsync fails after the worker claims its visible target", async () => {
    const files = await fixture();
    const probe = await open(files.adminOpsDirectory, "r");
    const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void>; stat: () => Promise<Awaited<ReturnType<typeof probe.stat>>> };
    await probe.close();
    const originalSync = prototype.sync;
    let directorySyncs = 0;
    const sync = vi.spyOn(prototype, "sync").mockImplementation(async function (this: typeof prototype) {
      const info = await this.stat();
      if (info.isDirectory() && ++directorySyncs === 2) {
        await rm(path.join(files.adminOpsDirectory, "inbox", `${JOB_A}.json`));
        throw new Error("simulated inbox directory fsync failure");
      }
      return Reflect.apply(originalSync, this, []);
    });

    try {
      await expect(files.gateway.createBackup({
        actorId: ADMIN_ID,
        requestId: "claimed-before-fsync",
        passphrase: "abcdefghijkl",
      })).resolves.toEqual({
        id: JOB_A,
        type: "backup",
        state: "queued",
        requestId: "claimed-before-fsync",
      });
      expect(await readFile(path.join(files.adminOpsDirectory, "inbox", `${JOB_A}.secret`), "utf8"))
        .toBe("abcdefghijkl");
      expect(JSON.parse(await readFile(
        path.join(files.adminOpsDirectory, "status", "active-job.json"),
        "utf8",
      ))).toMatchObject({ jobId: JOB_A });
    } finally {
      sync.mockRestore();
    }
  });

  it("uses a crash-released kernel lock and never steals a live holder", async () => {
    const portProbe = await import("node:net").then(({ createServer }) => createServer());
    const port = await new Promise<number>((resolve, reject) => {
      portProbe.once("error", reject);
      portProbe.listen(0, "127.0.0.1", () => {
        const address = portProbe.address();
        if (!address || typeof address === "string") reject(new Error("missing test port"));
        else resolve(address.port);
      });
    });
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));
    const child = spawn(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${port},"127.0.0.1",()=>process.stdout.write("ready\\n"))`,
    ], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
    });
    const files = await fixture([JOB_A], {
      submissionLockEndpoint: { type: "tcp", host: "127.0.0.1", port },
    });

    try {
      await expect(files.gateway.createBackup({
        actorId: ADMIN_ID,
        requestId: "live-lock",
        passphrase: "abcdefghijkl",
      })).rejects.toMatchObject({ status: 409, code: "MAINTENANCE_BUSY" });
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }

    await expect(files.gateway.createBackup({
      actorId: ADMIN_ID,
      requestId: "after-crash",
      passphrase: "abcdefghijkl",
    })).resolves.toMatchObject({ id: JOB_A, state: "queued" });
  });

  it("queues a backup with a private secret and an identifier-only job published last", async () => {
    const files = await fixture();

    const job = await files.gateway.createBackup({
      actorId: ADMIN_ID,
      requestId: "01JREQ",
      passphrase: "portable secret phrase",
    });

    expect(job).toEqual({ id: JOB_A, type: "backup", state: "queued", requestId: "01JREQ" });
    expect(await files.job(job.id)).toEqual({
      schemaVersion: 1,
      id: JOB_A,
      type: "backup",
      actorId: ADMIN_ID,
      requestId: "01JREQ",
    });
    const secret = path.join(files.adminOpsDirectory, "inbox", `${JOB_A}.secret`);
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(files.adminOpsDirectory, "inbox", `${JOB_A}.json`))).mode & 0o777)
      .toBe(0o600);
    expect((await files.publicFiles()).join("\n")).not.toContain("portable secret phrase");
  });

  it("admits only one of two concurrent maintenance submissions", async () => {
    const files = await fixture();

    const settled = await Promise.allSettled([
      files.gateway.createBackup({ actorId: ADMIN_ID, requestId: "parallel-a", passphrase: "abcdefghijkl" }),
      files.gateway.createBackup({ actorId: ADMIN_ID, requestId: "parallel-b", passphrase: "mnopqrstuvwx" }),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { status: 409, code: "MAINTENANCE_BUSY" } });
    expect((await readdir(path.join(files.adminOpsDirectory, "inbox"))).filter((name) => name.endsWith(".json")))
      .toHaveLength(1);
  });

  it("keeps a claimed job busy while root authority is inaccessible and status is not yet published", async () => {
    const files = await fixture();
    await files.gateway.createBackup({
      actorId: ADMIN_ID,
      requestId: "claimed-a",
      passphrase: "abcdefghijkl",
    });
    await rm(path.join(files.adminOpsDirectory, "inbox", `${JOB_A}.json`));

    await expect(files.gateway.createBackup({
      actorId: ADMIN_ID,
      requestId: "claimed-b",
      passphrase: "mnopqrstuvwx",
    })).rejects.toMatchObject({ status: 409, code: "MAINTENANCE_BUSY" });
  });

  it("removes upload and secret when atomic task publication loses an O_EXCL race", async () => {
    const files = await fixture();
    let collisionPublished = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!collisionPublished) {
          collisionPublished = true;
          await writeFile(path.join(files.adminOpsDirectory, "inbox", `${JOB_A}.json`), "existing");
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        }
      },
    });

    await expect(files.gateway.writeUpload({
      actorId: ADMIN_ID,
      requestId: "upload-race",
      fileName: "fitgridweb-20260903T070000Z.fitgridbackup",
      size: 3,
      passphrase: "abcdefghijkl",
    }, stream)).rejects.toMatchObject({ status: 409, code: "MAINTENANCE_BUSY" });

    expect(await readFile(path.join(files.adminOpsDirectory, "inbox", `${JOB_A}.json`), "utf8"))
      .toBe("existing");
    await expect(lstat(path.join(files.adminOpsDirectory, "inbox", `${JOB_A}.secret`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(files.adminOpsDirectory, "uploads", `${JOB_A}.fitgridbackup`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(files.adminOpsDirectory, "status", "active-job.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("streams an upload before publishing the exact inspect-restore job", async () => {
    const files = await fixture();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });

    const job = await files.gateway.writeUpload({
      actorId: ADMIN_ID,
      requestId: "upload-ok",
      fileName: "fitgridweb-20260903T070000Z.fitgridbackup",
      size: 3,
      passphrase: "abcdefghijkl",
    }, stream);

    expect(job).toEqual({ id: JOB_A, type: "inspect-restore", state: "queued", requestId: "upload-ok" });
    expect(await files.job(JOB_A)).toEqual({
      schemaVersion: 1,
      id: JOB_A,
      type: "inspect-restore",
      actorId: ADMIN_ID,
      requestId: "upload-ok",
    });
    expect(await readFile(path.join(files.adminOpsDirectory, "uploads", `${JOB_A}.fitgridbackup`)))
      .toEqual(Buffer.from([1, 2, 3]));
    expect((await stat(path.join(files.adminOpsDirectory, "uploads", `${JOB_A}.fitgridbackup`))).mode & 0o777)
      .toBe(0o600);
  });

  it("cleans an interrupted or understated upload without publishing a job", async () => {
    const files = await fixture();
    const interrupted = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.error(new Error("socket closed at /private/upload"));
      },
    });

    await expect(files.gateway.writeUpload({
      actorId: ADMIN_ID,
      requestId: "upload-failed",
      fileName: "fitgridweb-20260903T070000Z.fitgridbackup",
      size: 3,
      passphrase: "abcdefghijkl",
    }, interrupted)).rejects.toThrow("socket closed");
    expect(await readdir(path.join(files.adminOpsDirectory, "uploads"))).toEqual([]);
    expect(await readdir(path.join(files.adminOpsDirectory, "inbox"))).toEqual([]);

    const understated = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    });
    await expect(files.gateway.writeUpload({
      actorId: ADMIN_ID,
      requestId: "upload-understated",
      fileName: "fitgridweb-20260903T070000Z.fitgridbackup",
      size: 3,
      passphrase: "abcdefghijkl",
    }, understated)).rejects.toMatchObject({ status: 422, code: "BACKUP_SIZE_MISMATCH" });
    expect(await readdir(path.join(files.adminOpsDirectory, "uploads"))).toEqual([]);
  });

  it("never overwrites or removes pre-existing O_EXCL upload and secret targets", async () => {
    const uploadCollision = await fixture([JOB_A]);
    const upload = path.join(uploadCollision.adminOpsDirectory, "uploads", `${JOB_A}.fitgridbackup`);
    await writeFile(upload, "pre-existing-upload");
    const body = () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    await expect(uploadCollision.gateway.writeUpload({
      actorId: ADMIN_ID,
      requestId: "upload-collision",
      fileName: "fitgridweb-20260903T070000Z.fitgridbackup",
      size: 3,
      passphrase: "abcdefghijkl",
    }, body())).rejects.toMatchObject({ status: 409, code: "MAINTENANCE_BUSY" });
    expect(await readFile(upload, "utf8")).toBe("pre-existing-upload");

    const secretCollision = await fixture([JOB_B]);
    const secret = path.join(secretCollision.adminOpsDirectory, "inbox", `${JOB_B}.secret`);
    await writeFile(secret, "pre-existing-secret");
    await expect(secretCollision.gateway.writeUpload({
      actorId: ADMIN_ID,
      requestId: "secret-collision",
      fileName: "fitgridweb-20260903T070000Z.fitgridbackup",
      size: 3,
      passphrase: "mnopqrstuvwx",
    }, body())).rejects.toMatchObject({ status: 409, code: "MAINTENANCE_BUSY" });
    expect(await readFile(secret, "utf8")).toBe("pre-existing-secret");
    await expect(lstat(path.join(secretCollision.adminOpsDirectory, "uploads", `${JOB_B}.fitgridbackup`)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases admission when acquiring the upload reader fails", async () => {
    const files = await fixture();
    const stream = new ReadableStream<Uint8Array>();
    const heldReader = stream.getReader();

    await expect(files.gateway.writeUpload({
      actorId: ADMIN_ID,
      requestId: "locked-stream",
      fileName: "fitgridweb-20260903T070000Z.fitgridbackup",
      size: 3,
      passphrase: "abcdefghijkl",
    }, stream)).rejects.toThrow();
    heldReader.releaseLock();

    await expect(files.gateway.createBackup({
      actorId: ADMIN_ID,
      requestId: "after-locked-stream",
      passphrase: "mnopqrstuvwx",
    })).resolves.toMatchObject({ id: JOB_B, state: "queued" });
  });

  it("returns a redacted validated status and treats malformed or symlink status as safe 500s", async () => {
    const files = await fixture();
    const statusPath = path.join(files.adminOpsDirectory, "status", `${JOB_A}.json`);
    await writeFile(statusPath, JSON.stringify({
      schemaVersion: 1,
      id: JOB_A,
      type: "restore",
      actorId: ADMIN_ID,
      requestId: "restore-request",
      state: "failed",
      updatedAt: "2026-09-03T07:00:00Z",
      code: "RESTORE_FAILED",
      rolledBack: true,
    }));

    await expect(files.gateway.getJob(JOB_A)).resolves.toEqual({
      id: JOB_A,
      type: "restore",
      requestId: "restore-request",
      state: "failed",
      updatedAt: "2026-09-03T07:00:00Z",
      code: "RESTORE_FAILED",
      rolledBack: true,
    });
    expect(JSON.stringify(await files.gateway.getJob(JOB_A))).not.toContain(ADMIN_ID);

    await writeFile(statusPath, '{"state":"failed","detail":"postgresql://private-host/db"');
    await expect(files.gateway.getJob(JOB_A)).rejects.toMatchObject({
      status: 500,
      code: "MAINTENANCE_STATE_INVALID",
    });

    const outside = path.join(files.root, "outside-status.json");
    await writeFile(outside, JSON.stringify({ schemaVersion: 1, id: JOB_A }));
    await (await import("node:fs/promises")).rm(statusPath);
    await symlink(outside, statusPath);
    await expect(files.gateway.getJob(JOB_A)).rejects.toMatchObject({
      status: 500,
      code: "MAINTENANCE_STATE_INVALID",
    });
  });

  it("rejects a status containing an untrusted manifest app image without echoing it", async () => {
    const files = await fixture();
    const hostile = "image:password=portable-secret@/var/lib/private-host/database";
    await writeFile(path.join(files.adminOpsDirectory, "status", `${JOB_A}.json`), JSON.stringify({
      schemaVersion: 1,
      id: JOB_A,
      type: "inspect-restore",
      actorId: ADMIN_ID,
      requestId: "hostile-preview",
      state: "awaiting-confirmation",
      updatedAt: "2026-09-03T07:00:00Z",
      expiresAt: 2_000_000_000,
      backupCreatedAt: "2026-09-03T06:30:00Z",
      appImage: hostile,
      postgresMajor: 17,
      database: "fitgridweb",
      preview: { users: 2, gridTrades: 24, invitations: 1, importPreviews: 0 },
    }));

    let caught: unknown;
    try {
      await files.gateway.getJob(JOB_A);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ status: 500, code: "MAINTENANCE_STATE_INVALID" });
    const serializedError = JSON.stringify(caught);
    expect(serializedError).not.toContain(hostile);
    expect(serializedError).not.toContain("portable-secret");
    expect(serializedError).not.toContain("private-host");
  });

  it("rejects a status that grows beyond the read limit after its open-handle stat", async () => {
    const files = await fixture();
    const statusPath = path.join(files.adminOpsDirectory, "status", `${JOB_A}.json`);
    await writeFile(statusPath, JSON.stringify({
      schemaVersion: 1,
      id: JOB_A,
      type: "backup",
      actorId: ADMIN_ID,
      requestId: "growing-status",
      state: "ready",
      updatedAt: "2026-09-03T07:00:00Z",
    }));
    const probe = await open(statusPath, "r");
    const prototype = Object.getPrototypeOf(probe) as { stat: () => Promise<Awaited<ReturnType<typeof probe.stat>>> };
    await probe.close();
    const originalStat = prototype.stat;
    let grown = false;
    const statSpy = vi.spyOn(prototype, "stat").mockImplementation(async function (this: typeof prototype) {
      const info = await Reflect.apply(originalStat, this, []);
      if (!grown && info.isFile()) {
        grown = true;
        await appendFile(statusPath, Buffer.alloc(300 * 1024, 0x20));
      }
      return info;
    });

    try {
      await expect(files.gateway.getJob(JOB_A)).rejects.toMatchObject({
        status: 500,
        code: "MAINTENANCE_STATE_INVALID",
      });
    } finally {
      statSpy.mockRestore();
    }
  });

  it("rejects a structurally valid status with an impossible job state", async () => {
    const files = await fixture();
    await writeFile(path.join(files.adminOpsDirectory, "status", `${JOB_A}.json`), JSON.stringify({
      schemaVersion: 1,
      id: JOB_A,
      type: "restore",
      actorId: ADMIN_ID,
      requestId: "restore-request",
      state: "ready",
      updatedAt: "2026-09-03T07:00:00Z",
    }));

    await expect(files.gateway.getJob(JOB_A)).rejects.toMatchObject({
      status: 500,
      code: "MAINTENANCE_STATE_INVALID",
    });
  });

  it("clears a terminal inspection admission and publishes the exact bound restore job", async () => {
    const files = await fixture();
    await files.gateway.createBackup({ actorId: ADMIN_ID, requestId: "inspect-submit", passphrase: "abcdefghijkl" });
    await rm(path.join(files.adminOpsDirectory, "inbox", `${JOB_A}.json`));
    await rm(path.join(files.adminOpsDirectory, "inbox", `${JOB_A}.secret`));
    await writeFile(path.join(files.adminOpsDirectory, "status", `${JOB_A}.json`), JSON.stringify({
      schemaVersion: 1,
      id: JOB_A,
      type: "inspect-restore",
      actorId: ADMIN_ID,
      requestId: "inspect-submit",
      state: "awaiting-confirmation",
      updatedAt: "2026-09-03T07:00:00Z",
      expiresAt: 2_000_000_000,
      backupCreatedAt: "2026-09-03T06:30:00Z",
      postgresMajor: 17,
      database: "fitgridweb",
      preview: { users: 2, gridTrades: 24, invitations: 1, importPreviews: 0 },
    }));

    const job = await files.gateway.confirmRestore({
      actorId: ADMIN_ID,
      requestId: "restore-submit",
      restoreId: JOB_A,
    });

    expect(job).toEqual({ id: JOB_B, type: "restore", state: "queued", requestId: "restore-submit" });
    expect(await files.job(JOB_B)).toEqual({
      schemaVersion: 1,
      id: JOB_B,
      type: "restore",
      actorId: ADMIN_ID,
      requestId: "restore-submit",
      restoreId: JOB_A,
    });
  });

  it("rejects traversal identifiers before disk access", async () => {
    const files = await fixture();
    await rm(path.join(files.adminOpsDirectory, "status"), { recursive: true });
    await symlink(path.join(files.root, "missing-status"), path.join(files.adminOpsDirectory, "status"));
    await expect(files.gateway.getJob("../../etc/passwd")).rejects.toMatchObject({ status: 404 });
    await expect(files.gateway.confirmRestore({
      actorId: ADMIN_ID,
      requestId: "restore-request",
      restoreId: "../../prepared",
    })).rejects.toMatchObject({ status: 404 });
    await expect(files.gateway.getBackupFile("../backup")).rejects.toMatchObject({ status: 404 });
  });

  it("filters missing and symlink archives, de-duplicates, sorts newest first, and returns five", async () => {
    const files = await fixture();
    const entries = [];
    for (let day = 1; day <= 7; day += 1) {
      const id = `backup-${day}`;
      const filename = `fitgridweb-2026090${day}T070000Z.fitgridbackup`;
      const archive = path.join(files.portableBackupDirectory, filename);
      if (day === 2) {
        const outside = path.join(files.root, "outside.fitgridbackup");
        await writeFile(outside, new Uint8Array(day));
        await symlink(outside, archive);
      } else if (day !== 3) {
        await writeFile(archive, new Uint8Array(day));
      }
      entries.push({
        id,
        filename,
        createdAt: `2026-09-0${day}T07:00:00Z`,
        size: day,
        sha256: String(day).repeat(64).slice(0, 64),
        status: day === 1 ? "failed" : "ready",
      });
    }
    entries.push({ ...entries[6] });
    await writeFile(files.portableBackupHistoryFile, JSON.stringify({ entries }));

    await expect(files.gateway.listBackups()).resolves.toEqual([
      { id: "backup-7", createdAt: "2026-09-07T07:00:00Z", size: 7, sha256: "7".repeat(64) },
      { id: "backup-6", createdAt: "2026-09-06T07:00:00Z", size: 6, sha256: "6".repeat(64) },
      { id: "backup-5", createdAt: "2026-09-05T07:00:00Z", size: 5, sha256: "5".repeat(64) },
      { id: "backup-4", createdAt: "2026-09-04T07:00:00Z", size: 4, sha256: "4".repeat(64) },
    ]);
  });

  it("fails closed on malformed history instead of exposing disk contents", async () => {
    const files = await fixture();
    await writeFile(files.portableBackupHistoryFile, JSON.stringify({
      entries: [{ id: "backup-1", filename: "../../etc/passwd", status: "ready" }],
    }));

    await expect(files.gateway.listBackups()).rejects.toMatchObject({
      status: 500,
      code: "MAINTENANCE_STATE_INVALID",
    });
  });
});
