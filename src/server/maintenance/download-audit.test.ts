import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileDownloadAuditGateway } from "./download-audit";

const AUDIT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const BACKUP_ID = "backup-20260903";
const REQUEST_ID = "request_admin_download_0001";
const ACKNOWLEDGMENT_EXPIRES_AT = Math.floor(Date.now() / 1_000) + 60;
const currentUid = process.getuid?.() ?? 0;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const adminOpsDirectory = await realpath(await mkdtemp(path.join(tmpdir(), "fitgrid-download-audit-")));
  roots.push(adminOpsDirectory);
  await mkdir(path.join(adminOpsDirectory, "inbox"), { mode: 0o700 });
  await mkdir(path.join(adminOpsDirectory, "status"), { mode: 0o750 });
  const gateway = new FileDownloadAuditGateway({
    adminOpsDirectory,
    idGenerator: () => AUDIT_ID,
    acknowledgmentTimeoutMs: 1_000,
    pollIntervalMs: 5,
    acknowledgmentUid: currentUid,
  });
  return {
    adminOpsDirectory,
    gateway,
    request: path.join(adminOpsDirectory, "inbox", `${AUDIT_ID}.audit`),
    acknowledgment: path.join(adminOpsDirectory, "status", `${AUDIT_ID}.audit`),
  };
}

const input = {
  event: "download-token-issued" as const,
  actorId: ADMIN_ID,
  requestId: REQUEST_ID,
  backupId: BACKUP_ID,
};

describe("download audit gateway", () => {
  it("publishes only the fixed audit schema and waits for the root acknowledgment", async () => {
    const files = await fixture();
    const persistence = files.gateway.persist({
      ...input,
      token: "must-never-be-persisted",
      path: "/private/host/archive",
    } as typeof input);

    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(files.request, "utf8"))).toEqual({
        schemaVersion: 1,
        id: AUDIT_ID,
        event: "download-token-issued",
        actorId: ADMIN_ID,
        requestId: REQUEST_ID,
        backupId: BACKUP_ID,
      });
    });
    expect((await lstat(files.request)).mode & 0o777).toBe(0o600);

    await writeFile(files.acknowledgment, `${JSON.stringify({
      schemaVersion: 1,
      id: AUDIT_ID,
      state: "persisted",
      expiresAt: ACKNOWLEDGMENT_EXPIRES_AT,
    })}\n`, { mode: 0o640 });
    await expect(persistence).resolves.toBeUndefined();
    await expect(lstat(files.acknowledgment)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on a malformed root acknowledgment", async () => {
    const files = await fixture();
    const persistence = files.gateway.persist(input);
    await vi.waitFor(async () => expect(await lstat(files.request)).toBeDefined());
    await writeFile(files.acknowledgment, JSON.stringify({
      schemaVersion: 1,
      id: AUDIT_ID,
      state: "persisted",
      expiresAt: ACKNOWLEDGMENT_EXPIRES_AT,
      token: "unexpected",
    }), { mode: 0o640 });

    await expect(persistence).rejects.toMatchObject({
      status: 500,
      code: "DOWNLOAD_AUDIT_STATE_INVALID",
    });
  });

  it("rejects unsafe identities without publishing an audit request", async () => {
    const files = await fixture();

    await expect(files.gateway.persist({
      ...input,
      backupId: "../../private",
    })).rejects.toMatchObject({
      status: 500,
      code: "DOWNLOAD_AUDIT_STATE_INVALID",
    });
    await expect(lstat(files.request)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("times out rather than treating an unacknowledged spool write as durable root audit", async () => {
    const files = await fixture();
    const gateway = new FileDownloadAuditGateway({
      adminOpsDirectory: files.adminOpsDirectory,
      idGenerator: () => AUDIT_ID,
      acknowledgmentTimeoutMs: 20,
      pollIntervalMs: 2,
      acknowledgmentUid: currentUid,
    });

    await expect(gateway.persist(input)).rejects.toMatchObject({
      status: 503,
      code: "DOWNLOAD_AUDIT_UNAVAILABLE",
    });
    expect(await readFile(files.request, "utf8")).toContain(AUDIT_ID);
  });

  it("rejects an unsafe acknowledgment file type", async () => {
    const files = await fixture();
    const persistence = files.gateway.persist(input);
    await vi.waitFor(async () => expect(await lstat(files.request)).toBeDefined());
    await mkdir(files.acknowledgment);

    await expect(persistence).rejects.toMatchObject({
      status: 500,
      code: "DOWNLOAD_AUDIT_STATE_INVALID",
    });
  });

  it("rejects an acknowledgment not owned by the expected root uid", async () => {
    const files = await fixture();
    const gateway = new FileDownloadAuditGateway({
      adminOpsDirectory: files.adminOpsDirectory,
      idGenerator: () => AUDIT_ID,
      acknowledgmentTimeoutMs: 1_000,
      pollIntervalMs: 5,
      acknowledgmentUid: currentUid + 1,
    });
    const persistence = gateway.persist(input);
    await vi.waitFor(async () => expect(await lstat(files.request)).toBeDefined());
    await writeFile(files.acknowledgment, JSON.stringify({
      schemaVersion: 1,
      id: AUDIT_ID,
      state: "persisted",
      expiresAt: ACKNOWLEDGMENT_EXPIRES_AT,
    }), { mode: 0o640 });

    await expect(persistence).rejects.toMatchObject({
      status: 500,
      code: "DOWNLOAD_AUDIT_STATE_INVALID",
    });
  });

  it("rejects an expired root acknowledgment without deleting it", async () => {
    const files = await fixture();
    const persistence = files.gateway.persist(input);
    await vi.waitFor(async () => expect(await lstat(files.request)).toBeDefined());
    await writeFile(files.acknowledgment, JSON.stringify({
      schemaVersion: 1,
      id: AUDIT_ID,
      state: "persisted",
      expiresAt: Math.floor(Date.now() / 1_000) - 1,
    }), { mode: 0o640 });

    await expect(persistence).rejects.toMatchObject({
      status: 500,
      code: "DOWNLOAD_AUDIT_STATE_INVALID",
    });
    expect(JSON.parse(await readFile(files.acknowledgment, "utf8"))).toMatchObject({
      id: AUDIT_ID,
      state: "persisted",
    });
  });
});
