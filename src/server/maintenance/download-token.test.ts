import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DownloadTokenService } from "./download-token";

const SECRET = "download-token-secret-that-is-at-least-32-characters";
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ADMIN = "22222222-2222-4222-8222-222222222222";
const BACKUP_ID = "backup-20260903";
const OTHER_BACKUP = "backup-20260902";
const NOW = 1_788_400_000;
const MARKER_LIMIT = 256;
const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tokenFixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "fitgrid-token-")));
  roots.push(root);
  const markerDirectory = path.join(root, "used-download-tokens");
  await mkdir(markerDirectory, { mode: 0o700 });
  return { root, markerDirectory };
}

describe("persistent download tokens", () => {
  it("consumes once across service instances and binds the admin and backup", async () => {
    const files = await tokenFixture();
    const issuer = new DownloadTokenService({ secret: SECRET, markerDirectory: files.markerDirectory });
    const consumerAfterRestart = new DownloadTokenService({ secret: SECRET, markerDirectory: files.markerDirectory });

    const token = issuer.issue({ adminId: ADMIN_ID, backupId: BACKUP_ID, now: NOW });
    await expect(consumerAfterRestart.consume(token, ADMIN_ID, BACKUP_ID, NOW)).resolves.toBeUndefined();
    await expect(issuer.consume(token, ADMIN_ID, BACKUP_ID, NOW)).rejects.toMatchObject({ status: 404 });
  });

  it("does not burn a token on admin or backup mismatch", async () => {
    const files = await tokenFixture();
    const service = new DownloadTokenService({ secret: SECRET, markerDirectory: files.markerDirectory });
    const token = service.issue({ adminId: ADMIN_ID, backupId: BACKUP_ID, now: NOW });

    await expect(service.consume(token, OTHER_ADMIN, BACKUP_ID, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(service.consume(token, ADMIN_ID, OTHER_BACKUP, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(service.consume(token, ADMIN_ID, BACKUP_ID, NOW)).resolves.toBeUndefined();
  });

  it("allows exactly one of two parallel consumers", async () => {
    const files = await tokenFixture();
    const serviceA = new DownloadTokenService({ secret: SECRET, markerDirectory: files.markerDirectory });
    const serviceB = new DownloadTokenService({ secret: SECRET, markerDirectory: files.markerDirectory });
    const token = serviceA.issue({ adminId: ADMIN_ID, backupId: BACKUP_ID, now: NOW });

    const settled = await Promise.allSettled([
      serviceA.consume(token, ADMIN_ID, BACKUP_ID, NOW),
      serviceB.consume(token, ADMIN_ID, BACKUP_ID, NOW),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected"))
      .toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 404 }) })]);
  });

  it("prunes only expired validated markers before consuming a new token", async () => {
    const files = await tokenFixture();
    const expiredDigest = "a".repeat(64);
    const liveDigest = "b".repeat(64);
    await writeFile(path.join(files.markerDirectory, `${expiredDigest}.used`), JSON.stringify({
      schemaVersion: 1,
      digest: expiredDigest,
      exp: NOW,
    }), { mode: 0o600 });
    await writeFile(path.join(files.markerDirectory, `${liveDigest}.used`), JSON.stringify({
      schemaVersion: 1,
      digest: liveDigest,
      exp: NOW + 1,
    }), { mode: 0o600 });
    const service = new DownloadTokenService({ secret: SECRET, markerDirectory: files.markerDirectory });
    const token = service.issue({ adminId: ADMIN_ID, backupId: BACKUP_ID, now: NOW });

    await expect(service.consume(token, ADMIN_ID, BACKUP_ID, NOW)).resolves.toBeUndefined();
    await expect(lstat(path.join(files.markerDirectory, `${expiredDigest}.used`)))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(files.markerDirectory, `${liveDigest}.used`), "utf8"))
      .toContain(liveDigest);
  });

  it("rejects admission when the fixed live-marker capacity is full", async () => {
    const files = await tokenFixture();
    await Promise.all(Array.from({ length: MARKER_LIMIT }, async (_, index) => {
      const digest = createHash("sha256").update(`live-${index}`).digest("hex");
      await writeFile(path.join(files.markerDirectory, `${digest}.used`), JSON.stringify({
        schemaVersion: 1,
        digest,
        exp: NOW + 60,
      }), { mode: 0o600 });
    }));
    const service = new DownloadTokenService({ secret: SECRET, markerDirectory: files.markerDirectory });
    const token = service.issue({ adminId: ADMIN_ID, backupId: BACKUP_ID, now: NOW });

    await expect(service.consume(token, ADMIN_ID, BACKUP_ID, NOW)).rejects.toMatchObject({
      status: 503,
      code: "DOWNLOAD_TOKEN_STORE_FULL",
    });
    expect(await readdir(files.markerDirectory)).toHaveLength(MARKER_LIMIT);
  });

  it("fails closed on malformed or symlink token markers without deleting them", async () => {
    const malformedFiles = await tokenFixture();
    const malformedDigest = "c".repeat(64);
    const malformed = path.join(malformedFiles.markerDirectory, `${malformedDigest}.used`);
    await writeFile(malformed, "not-json", { mode: 0o600 });
    const malformedService = new DownloadTokenService({ secret: SECRET, markerDirectory: malformedFiles.markerDirectory });
    const malformedToken = malformedService.issue({ adminId: ADMIN_ID, backupId: BACKUP_ID, now: NOW });
    await expect(malformedService.consume(malformedToken, ADMIN_ID, BACKUP_ID, NOW)).rejects.toMatchObject({
      status: 500,
      code: "DOWNLOAD_TOKEN_STATE_INVALID",
    });
    expect(await readFile(malformed, "utf8")).toBe("not-json");

    const symlinkFiles = await tokenFixture();
    const outside = path.join(symlinkFiles.root, "outside-marker");
    await writeFile(outside, "outside");
    const symlinkDigest = "d".repeat(64);
    const markerLink = path.join(symlinkFiles.markerDirectory, `${symlinkDigest}.used`);
    await symlink(outside, markerLink);
    const symlinkService = new DownloadTokenService({ secret: SECRET, markerDirectory: symlinkFiles.markerDirectory });
    const symlinkToken = symlinkService.issue({ adminId: ADMIN_ID, backupId: BACKUP_ID, now: NOW });
    await expect(symlinkService.consume(symlinkToken, ADMIN_ID, BACKUP_ID, NOW)).rejects.toMatchObject({
      status: 500,
      code: "DOWNLOAD_TOKEN_STATE_INVALID",
    });
    expect(await readFile(outside, "utf8")).toBe("outside");
    expect((await lstat(markerLink)).isSymbolicLink()).toBe(true);
  });

  it("rejects expiry, tampering, malformed payloads, and invalid identifiers as indistinguishable 404s", async () => {
    const files = await tokenFixture();
    const service = new DownloadTokenService({ secret: SECRET, markerDirectory: files.markerDirectory });
    const token = service.issue({ adminId: ADMIN_ID, backupId: BACKUP_ID, now: NOW });

    await expect(service.consume(token, ADMIN_ID, BACKUP_ID, NOW + 60)).rejects.toMatchObject({ status: 404 });
    await expect(service.consume(`${token}x`, ADMIN_ID, BACKUP_ID, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(service.consume("not-a-token", ADMIN_ID, BACKUP_ID, NOW)).rejects.toMatchObject({ status: 404 });
    expect(() => service.issue({ adminId: "../../admin", backupId: BACKUP_ID, now: NOW }))
      .toThrowError(expect.objectContaining({ status: 404 }));
  });

  it("rejects a symlinked marker directory without writing outside the spool", async () => {
    const files = await tokenFixture();
    const outside = path.join(files.root, "outside");
    await mkdir(outside);
    const markerDirectory = path.join(files.root, "marker-link");
    await symlink(outside, markerDirectory);
    const service = new DownloadTokenService({ secret: SECRET, markerDirectory });
    const token = service.issue({ adminId: ADMIN_ID, backupId: BACKUP_ID, now: NOW });

    await expect(service.consume(token, ADMIN_ID, BACKUP_ID, NOW)).rejects.toMatchObject({
      status: 500,
      code: "DOWNLOAD_TOKEN_STATE_INVALID",
    });
    await writeFile(path.join(outside, "sentinel"), "untouched");
  });
});
