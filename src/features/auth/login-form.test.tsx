// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientApiError } from "@/lib/api-client";
import { LoginForm } from "./login-form";

const session = {
  user: { id: "u1", username: "admin", role: "admin" as const, status: "active" as const },
  expiresAt: "2026-09-08T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("LoginForm", () => {
  it("shows the local credentials when UI demo mode is enabled", () => {
    vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
    vi.stubEnv("NODE_ENV", "development");
    render(<LoginForm returnTo="/grids" request={vi.fn()} navigate={vi.fn()} />);

    expect(screen.getByRole("note")).toHaveTextContent("demo");
    expect(screen.getByRole("note")).toHaveTextContent("fitgrid-demo");

  });

  it("logs in and replaces the page with the safe return route", async () => {
    const request = vi.fn().mockResolvedValue(session);
    const navigate = vi.fn();
    render(<LoginForm returnTo="/grids?q=gold" request={request} navigate={navigate} />);
    await userEvent.type(screen.getByLabelText("用户名"), "admin");
    await userEvent.type(screen.getByLabelText("密码"), "long-password");
    await userEvent.click(screen.getByRole("button", { name: "登录工作台" }));
    expect(request).toHaveBeenCalledWith("admin", "long-password");
    expect(navigate).toHaveBeenCalledWith("/grids?q=gold");
  });

  it("uses one generic message for a 401 and retains only the username", async () => {
    const request = vi.fn().mockRejectedValue(new ClientApiError(401, "UNAUTHORIZED", "用户名或密码错误"));
    render(<LoginForm returnTo="/grids" request={request} navigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("用户名"), "admin");
    await userEvent.type(screen.getByLabelText("密码"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "登录工作台" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("登录失败");
    expect(alert).toHaveTextContent("用户名或密码错误");
    expect(screen.getByLabelText("用户名")).toHaveValue("admin");
    expect(screen.getByLabelText("密码")).toHaveValue("");
  });

  it("associates 422 field errors with the corresponding controls", async () => {
    const request = vi.fn().mockRejectedValue(new ClientApiError(
      422,
      "VALIDATION_ERROR",
      "请求参数校验失败",
      "01FIELD",
      { username: ["用户名不能为空"], password: ["密码长度不符合要求"] },
    ));
    render(<LoginForm returnTo="/grids" request={request} navigate={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "登录工作台" }));
    expect(await screen.findByText("用户名不能为空")).toHaveAttribute("id", "username-error");
    expect(screen.getByLabelText("用户名")).toHaveAttribute("aria-describedby", "username-error");
    expect(screen.getByText("密码长度不符合要求")).toHaveAttribute("id", "password-error");
  });

  it("shows the server rate-limit countdown", async () => {
    const request = vi.fn().mockRejectedValue(new ClientApiError(429, "RATE_LIMITED", "请求过快", "01REQ", undefined, 37));
    render(<LoginForm returnTo="/grids" request={request} navigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("用户名"), "admin");
    await userEvent.type(screen.getByLabelText("密码"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "登录工作台" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请求过快，37 秒后重试");
  });

  it("prevents duplicate submission while the first request is pending", async () => {
    let resolve!: (value: typeof session) => void;
    const request = vi.fn(() => new Promise<typeof session>((done) => { resolve = done; }));
    render(<LoginForm returnTo="/grids" request={request} navigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("用户名"), "admin");
    await userEvent.type(screen.getByLabelText("密码"), "long-password");
    const button = screen.getByRole("button", { name: "登录工作台" });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(session); });
  });

  it("keeps the username and allows retry after a network failure", async () => {
    const request = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(session);
    const navigate = vi.fn();
    render(<LoginForm returnTo="/grids" request={request} navigate={navigate} />);
    await userEvent.type(screen.getByLabelText("用户名"), "admin");
    await userEvent.type(screen.getByLabelText("密码"), "long-password");
    await userEvent.click(screen.getByRole("button", { name: "登录工作台" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("网络连接失败，请重试");
    expect(screen.getByLabelText("用户名")).toHaveValue("admin");
    await userEvent.type(screen.getByLabelText("密码"), "long-password");
    await userEvent.click(screen.getByRole("button", { name: "登录工作台" }));
    expect(navigate).toHaveBeenCalledWith("/grids");
  });
});
