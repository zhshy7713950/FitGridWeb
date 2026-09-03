import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("./demo-grid-data");
  vi.resetModules();
  vi.unstubAllEnvs();
});

it("does not initialize the demo repository when the production API module loads", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "0");
  const initializeDemoRepository = vi.fn();
  vi.doMock("./demo-grid-data", () => {
    initializeDemoRepository();
    return {};
  });

  await import("./grid-api");

  expect(initializeDemoRepository).not.toHaveBeenCalled();
});
