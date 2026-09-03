// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { browserUnauthorizedRedirect } = vi.hoisted(() => ({
  browserUnauthorizedRedirect: vi.fn(),
}));

vi.mock("@/lib/app-paths", () => ({ browserUnauthorizedRedirect }));

import { ProtectedLoginRedirect } from "./protected-login-redirect";

afterEach(() => {
  cleanup();
  browserUnauthorizedRedirect.mockReset();
});

it("redirects the browser from an anonymous protected route without protected content", async () => {
  render(<ProtectedLoginRedirect />);

  expect(screen.getByRole("status")).toHaveTextContent("正在进入登录页");
  await waitFor(() => expect(browserUnauthorizedRedirect).toHaveBeenCalledTimes(1));
});
