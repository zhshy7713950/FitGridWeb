import { describe, expect, it } from "vitest";

import {
  InvitationService,
  type InvitationAcceptInput,
  type InvitationRecord,
  type InvitationRepository,
} from "@/server/invitations/invitation-service";

class MemoryInvitations implements InvitationRepository {
  records = new Map<string, InvitationRecord>();
  accepted: InvitationAcceptInput[] = [];

  async create(record: InvitationRecord): Promise<InvitationRecord> {
    this.records.set(record.tokenDigest, record);
    return record;
  }

  async findByDigest(digest: string): Promise<InvitationRecord | null> {
    return this.records.get(digest) ?? null;
  }

  async accept(input: InvitationAcceptInput): Promise<"accepted" | "unavailable" | "username_conflict"> {
    const record = this.records.get(input.tokenDigest);
    if (!record || record.usedAt || record.expiresAt <= input.now) return "unavailable";
    record.usedAt = input.now;
    record.usedById = input.userId;
    this.accepted.push(input);
    return "accepted";
  }
}

describe("InvitationService", () => {
  it("returns a 256-bit token once and stores only its digest", async () => {
    const repository = new MemoryInvitations();
    const service = new InvitationService(repository, async (password) => `hash:${password}`);
    const created = await service.create("admin-id", 24, new Date("2026-09-01T00:00:00Z"));

    expect(Buffer.from(created.token, "base64url")).toHaveLength(32);
    expect(repository.records.size).toBe(1);
    const [stored] = repository.records.values();
    expect(stored.tokenDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.tokenDigest).not.toContain(created.token);
    expect(created.expiresAt).toBe("2026-09-02T00:00:00.000Z");
  });

  it("accepts once with a hashed credential and then reports used", async () => {
    const repository = new MemoryInvitations();
    const service = new InvitationService(repository, async (password) => `hash:${password}`);
    const created = await service.create("admin-id", 24, new Date("2026-09-01T00:00:00Z"));
    const accepted = await service.accept(
      created.token,
      "Alice",
      "correct horse battery",
      new Date("2026-09-01T01:00:00Z"),
    );

    expect(accepted.username).toBe("alice");
    expect(repository.accepted[0].passwordHash).toBe("hash:correct horse battery");
    expect(await service.status(created.token, new Date("2026-09-01T02:00:00Z"))).toEqual({
      status: "used",
      expiresAt: "2026-09-02T00:00:00.000Z",
    });
    await expect(
      service.accept(created.token, "Bob", "correct horse battery", new Date("2026-09-01T03:00:00Z")),
    ).rejects.toMatchObject({ status: 404, code: "INVITATION_NOT_FOUND" });
  });

  it("rejects invitation lifetimes outside one to 168 hours", async () => {
    const service = new InvitationService(new MemoryInvitations(), async (password) => password);
    await expect(service.create("admin-id", 0)).rejects.toMatchObject({ code: "INVITATION_TTL_INVALID" });
    await expect(service.create("admin-id", 169)).rejects.toMatchObject({ code: "INVITATION_TTL_INVALID" });
  });
});
