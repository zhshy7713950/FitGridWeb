// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientApiError } from "@/lib/api-client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

import { InvitationPage, InvitationPageView, type InvitationPageState } from "./invitation-page";

const validState = {
  kind: "valid",
  expiresAt: "2026-09-03T00:00:00.000Z",
} satisfies InvitationPageState;
const acceptedUser = {
  id: "user-1",
  username: "new-member",
  role: "member" as const,
  status: "active" as const,
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("InvitationPageView", () => {
  it("shows a restrained loading state without registration fields", () => {
    render(<InvitationPageView state={{ kind: "loading" }} />);

    expect(screen.getByRole("status")).toHaveTextContent("正在验证邀请");
    expect(screen.queryByLabelText("用户名")).not.toBeInTheDocument();
  });

  it.each([
    ["used", "邀请已使用"],
    ["expired", "邀请已过期"],
    ["invalid", "邀请无效或已失效"],
  ] as const)("does not show registration fields for %s invitations", (kind, heading) => {
    render(<InvitationPageView state={{ kind, expiresAt: null }} />);

    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.queryByLabelText("用户名")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  });

  it("uses an application-root login link from terminal invitation states", () => {
    render(<InvitationPageView state={{ kind: "invalid", expiresAt: null }} />);

    expect(screen.getByRole("link", { name: "前往登录" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "FitGrid 登录页" })).toHaveAttribute("href", "/login");
  });

  it("renders a recoverable public error with request ID, retry delay, and retry action", async () => {
    const retry = vi.fn();
    render(<InvitationPageView state={{
      kind: "error",
      message: "请求过快",
      requestId: "01INVITE",
      retryAfterSeconds: 41,
    }} onRetry={retry} />);

    expect(screen.getByRole("alert")).toHaveTextContent("请求过快");
    expect(screen.getByRole("alert")).toHaveTextContent("请求 ID：01INVITE");
    expect(screen.getByRole("alert")).toHaveTextContent("41 秒后重试");
    await userEvent.click(screen.getByRole("button", { name: "重新检查邀请" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("requires a 3–64 character username before accepting", async () => {
    const accept = vi.fn();
    render(<InvitationPageView state={validState} accept={accept} />);
    await userEvent.type(screen.getByLabelText("用户名"), "ab");
    await userEvent.type(screen.getByLabelText("密码"), "strong-password-1");
    await userEvent.type(screen.getByLabelText("确认密码"), "strong-password-1");
    await userEvent.click(screen.getByRole("button", { name: "创建账号" }));

    expect(accept).not.toHaveBeenCalled();
    expect(screen.getByText("用户名长度必须为 3–64 个字符")).toBeInTheDocument();
  });

  it("requires a 12–128 character password before accepting", async () => {
    const accept = vi.fn();
    render(<InvitationPageView state={validState} accept={accept} />);
    await userEvent.type(screen.getByLabelText("用户名"), "member");
    await userEvent.type(screen.getByLabelText("密码"), "too-short");
    await userEvent.type(screen.getByLabelText("确认密码"), "too-short");
    await userEvent.click(screen.getByRole("button", { name: "创建账号" }));

    expect(accept).not.toHaveBeenCalled();
    expect(screen.getByText("密码长度必须为 12–128 个字符")).toBeInTheDocument();
  });

  it("requires matching passwords before accepting", async () => {
    const accept = vi.fn();
    render(<InvitationPageView state={validState} accept={accept} />);
    await userEvent.type(screen.getByLabelText("用户名"), "member");
    await userEvent.type(screen.getByLabelText("密码"), "strong-password-1");
    await userEvent.type(screen.getByLabelText("确认密码"), "different-password");
    await userEvent.click(screen.getByRole("button", { name: "创建账号" }));

    expect(accept).not.toHaveBeenCalled();
    expect(screen.getByText("两次输入的密码不一致")).toBeInTheDocument();
  });

  it("maps server field errors while retaining the public message and request ID", async () => {
    const accept = vi.fn().mockRejectedValue(new ClientApiError(
      422,
      "VALIDATION_ERROR",
      "请检查注册信息",
      "01FIELDS",
      { username: ["用户名格式无效"], password: ["密码不符合规则"] },
    ));
    render(<InvitationPageView state={validState} accept={accept} />);
    await fillValidForm();
    await userEvent.click(screen.getByRole("button", { name: "创建账号" }));

    expect(await screen.findByText("用户名格式无效")).toHaveAttribute("id", "invite-username-error");
    expect(screen.getByText("密码不符合规则")).toHaveAttribute("id", "invite-password-error");
    expect(screen.getByRole("alert")).toHaveTextContent("请检查注册信息");
    expect(screen.getByRole("alert")).toHaveTextContent("请求 ID：01FIELDS");
  });

  it("keeps form data available for retry after a network failure", async () => {
    const accept = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"));
    render(<InvitationPageView state={validState} accept={accept} />);
    await fillValidForm();
    await userEvent.click(screen.getByRole("button", { name: "创建账号" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("网络连接失败，请重试");
    expect(screen.getByLabelText("用户名")).toHaveValue("member");
    expect(screen.getByLabelText("密码")).toHaveValue("strong-password-1");
  });

  it("turns a 404 during acceptance into a field-free invalid state", async () => {
    const accept = vi.fn().mockRejectedValue(new ClientApiError(
      404,
      "INVITATION_NOT_FOUND",
      "邀请不存在或已失效",
      "01GONE",
    ));
    render(<InvitationPageView state={validState} accept={accept} />);
    await fillValidForm();
    await userEvent.click(screen.getByRole("button", { name: "创建账号" }));

    expect(await screen.findByRole("heading", { name: "邀请无效或已失效" })).toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  });

  it("prevents synchronous repeated acceptance while the request is pending", async () => {
    let resolve!: (value: typeof acceptedUser) => void;
    const accept = vi.fn(() => new Promise<typeof acceptedUser>((done) => { resolve = done; }));
    render(<InvitationPageView state={validState} accept={accept} />);
    await fillValidForm();
    const form = screen.getByRole("button", { name: "创建账号" }).closest("form")!;

    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(accept).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在创建…" })).toBeDisabled();
    await act(async () => { resolve(acceptedUser); });
  });

  it("clears passwords, shows success, and keeps submission locked until replace", async () => {
    const onAccepted = vi.fn();
    const { rerender } = render(
      <InvitationPageView
        state={validState}
        accept={vi.fn().mockResolvedValue(acceptedUser)}
        onAccepted={onAccepted}
      />,
    );
    await fillValidForm();
    await userEvent.click(screen.getByRole("button", { name: "创建账号" }));

    expect(await screen.findByRole("heading", { name: "账号已创建" })).toBeInTheDocument();
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();

    rerender(<InvitationPageView state={{ kind: "expired", expiresAt: null }} />);
    rerender(<InvitationPageView state={validState} accept={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("密码")).toHaveValue(""));
    expect(screen.getByLabelText("确认密码")).toHaveValue("");
  });

  it("clears in-memory passwords when invitation state becomes non-valid", async () => {
    const { rerender } = render(<InvitationPageView state={validState} accept={vi.fn()} />);
    await fillValidForm();

    rerender(<InvitationPageView state={{ kind: "expired", expiresAt: null }} />);
    rerender(<InvitationPageView state={validState} accept={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("密码")).toHaveValue(""));
    expect(screen.getByLabelText("确认密码")).toHaveValue("");
  });

  it("uses password-manager-safe autocomplete without writing credentials to storage", async () => {
    const localWrite = vi.spyOn(Storage.prototype, "setItem");
    render(<InvitationPageView state={validState} accept={vi.fn().mockResolvedValue(acceptedUser)} />);

    expect(screen.getByLabelText("用户名")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("密码")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("确认密码")).toHaveAttribute("autocomplete", "new-password");
    await fillValidForm();
    await userEvent.click(screen.getByRole("button", { name: "创建账号" }));
    expect(localWrite).not.toHaveBeenCalled();
  });
});

describe("InvitationPage", () => {
  it("loads a valid token and replaces to the unprefixed login route after success", async () => {
    const status = vi.fn().mockResolvedValue(validStateToApi());
    const accept = vi.fn().mockResolvedValue(acceptedUser);
    const replace = vi.fn();
    render(<InvitationPage token="route-token" getStatus={status} accept={accept} replace={replace} />);

    expect(screen.getByRole("status")).toHaveTextContent("正在验证邀请");
    expect(await screen.findByRole("heading", { name: "创建你的账户" })).toBeInTheDocument();
    await fillValidForm();
    await userEvent.click(screen.getByRole("button", { name: "创建账号" }));

    expect(accept).toHaveBeenCalledWith("route-token", "member", "strong-password-1");
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("maps a status 404 to invalid without rendering fields", async () => {
    const status = vi.fn().mockRejectedValue(new ClientApiError(
      404,
      "INVITATION_NOT_FOUND",
      "邀请不存在",
      "01MISSING",
    ));
    render(<InvitationPage token="missing-token" getStatus={status} replace={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "邀请无效或已失效" })).toBeInTheDocument();
    expect(screen.queryByLabelText("用户名")).not.toBeInTheDocument();
  });

  it("allows a network status failure to be retried", async () => {
    const status = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(validStateToApi());
    render(<InvitationPage token="retry-token" getStatus={status} replace={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("网络连接失败，请重试");
    await userEvent.click(screen.getByRole("button", { name: "重新检查邀请" }));
    expect(await screen.findByRole("heading", { name: "创建你的账户" })).toBeInTheDocument();
    expect(status).toHaveBeenCalledTimes(2);
  });
});

async function fillValidForm() {
  await userEvent.type(screen.getByLabelText("用户名"), "member");
  await userEvent.type(screen.getByLabelText("密码"), "strong-password-1");
  await userEvent.type(screen.getByLabelText("确认密码"), "strong-password-1");
}

function validStateToApi() {
  return { status: "valid" as const, expiresAt: validState.expiresAt! };
}
