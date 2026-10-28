import { describe, expect, it, vi } from "vitest";
import { withTaskLock } from "./runtime";
describe.skipIf(!process.env.TEST_DATABASE_URL)("task overlap lock", () => {
  it("skips an overlapping in-process call immediately while retaining the database advisory lock", async () => {
    vi.stubEnv("DATABASE_URL", process.env.TEST_DATABASE_URL!);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const first = withTaskLock(async () => { entered(); await gate; return "first"; });
    await started;
    const second = withTaskLock(async () => "second");
    let observed: unknown;
    try { observed = await Promise.race([second, new Promise((r) => setTimeout(() => r("blocked"), 50))]); }
    finally { release(); await first; await second; vi.unstubAllEnvs(); }
    expect(observed).toEqual({ skipped: "busy" });
  });
});
