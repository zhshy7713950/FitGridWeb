// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LogoutButton } from "./logout-button";

afterEach(cleanup);

it("deletes the session then replaces the page with login", async () => {
  const request = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn();
  const user = userEvent.setup();

  render(<LogoutButton request={request} navigate={navigate} />);
  await user.click(screen.getByRole("button", { name: "退出登录" }));

  expect(request).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith("/login");
});

it("keeps the user in place and offers retry after failure", async () => {
  const request = vi.fn().mockRejectedValue(new Error("offline"));
  const navigate = vi.fn();
  const user = userEvent.setup();

  render(<LogoutButton request={request} navigate={navigate} />);
  await user.click(screen.getByRole("button", { name: "退出登录" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("退出失败，请重试");
  expect(navigate).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "退出登录" })).toBeEnabled();
});
