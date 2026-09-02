import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

it("refuses to compile a production image with UI demo mode enabled", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");

  await expect(import("../../../next.config")).rejects.toThrow(
    "UI demo mode is development-only",
  );
});
