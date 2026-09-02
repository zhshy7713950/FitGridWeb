// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientApiError } from "@/lib/api-client";
import { SecurityPage } from "./security-page";

type ChangePasswordRequest = (
  currentPassword: string,
  newPassword: string,
  signal?: AbortSignal,
) => Promise<void>;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SecurityPage", () => {
  it("renders controlled password inputs with password-manager-safe autocomplete", async () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    render(<SecurityPage changePassword={vi.fn()} />);

    expect(screen.getByLabelText("当前密码")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("当前密码")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByLabelText("当前密码")).toHaveAttribute("maxlength", "128");
    expect(screen.getByLabelText("新密码")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("新密码")).toHaveAttribute("minlength", "12");
    expect(screen.getByLabelText("新密码")).toHaveAttribute("maxlength", "128");
    expect(screen.getByLabelText("确认新密码")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("确认新密码")).toHaveAttribute("maxlength", "128");

    await userEvent.type(screen.getByLabelText("当前密码"), "private-current");
    await userEvent.type(screen.getByLabelText("新密码"), "private-replacement");
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it("does not submit an empty current password", async () => {
    const request = vi.fn<ChangePasswordRequest>();
    render(<SecurityPage changePassword={request} />);

    await userEvent.type(screen.getByLabelText("新密码"), "replacement-secret");
    await userEvent.type(screen.getByLabelText("确认新密码"), "replacement-secret");
    await userEvent.click(screen.getByRole("button", { name: "修改密码" }));

    expect(request).not.toHaveBeenCalled();
    expect(screen.getByText("请输入当前密码")).toBeInTheDocument();
  });

  it.each([
    ["short", "short", "新密码长度必须为 12–128 个字符"],
    ["replacement-secret", "different-secret", "两次输入的新密码不一致"],
  ])("rejects invalid new-password values before the API (%s)", async (password, confirmation, error) => {
    const request = vi.fn<ChangePasswordRequest>();
    render(<SecurityPage changePassword={request} />);
    await userEvent.type(screen.getByLabelText("当前密码"), "current-secret");
    await userEvent.type(screen.getByLabelText("新密码"), password);
    await userEvent.type(screen.getByLabelText("确认新密码"), confirmation);

    await userEvent.click(screen.getByRole("button", { name: "修改密码" }));

    expect(request).not.toHaveBeenCalled();
    expect(screen.getByText(error)).toBeInTheDocument();
  });

  it("maps CURRENT_PASSWORD_INVALID beside the current field and exposes public request details", async () => {
    const request = vi.fn<ChangePasswordRequest>().mockRejectedValue(new ClientApiError(
      401,
      "CURRENT_PASSWORD_INVALID",
      "当前密码错误",
      "01CURRENT",
    ));
    render(<SecurityPage changePassword={request} />);
    await fillValidForm();

    await userEvent.click(screen.getByRole("button", { name: "修改密码" }));

    expect(await screen.findByText("当前密码错误", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("当前密码错误");
    expect(screen.getByRole("alert")).toHaveTextContent("请求 ID：01CURRENT");
    expect(screen.getByLabelText("当前密码")).toHaveValue("");
    expect(screen.getByLabelText("新密码")).toHaveValue("replacement-secret");
    expect(screen.getByLabelText("确认新密码")).toHaveValue("replacement-secret");
  });

  it("maps server field errors to their matching controls", async () => {
    const request = vi.fn<ChangePasswordRequest>().mockRejectedValue(new ClientApiError(
      422,
      "VALIDATION_FAILED",
      "请求字段校验失败",
      "01FIELDS",
      {
        currentPassword: ["当前密码格式错误"],
        newPassword: ["新密码不能与当前密码相同"],
      },
    ));
    render(<SecurityPage changePassword={request} />);
    await fillValidForm();

    await userEvent.click(screen.getByRole("button", { name: "修改密码" }));

    expect(await screen.findByText("当前密码格式错误")).toBeInTheDocument();
    expect(screen.getByText("新密码不能与当前密码相同")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("请求字段校验失败");
    expect(screen.getByRole("alert")).toHaveTextContent("请求 ID：01FIELDS");
  });

  it("clears every password, shows success, and keeps the completed transition locked", async () => {
    const request = vi.fn<ChangePasswordRequest>().mockResolvedValue();
    render(<SecurityPage changePassword={request} />);
    await fillValidForm();
    const form = screen.getByRole("button", { name: "修改密码" }).closest("form")!;

    await userEvent.click(screen.getByRole("button", { name: "修改密码" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "密码已更新，其他设备的会话已撤销",
    );
    expect(screen.queryByLabelText("当前密码")).not.toBeInTheDocument();
    act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("prevents synchronous repeated submission while a request is pending", async () => {
    const pending = deferred<void>();
    const request = vi.fn<ChangePasswordRequest>(() => pending.promise);
    render(<SecurityPage changePassword={request} />);
    await fillValidForm();
    const form = screen.getByRole("button", { name: "修改密码" }).closest("form")!;

    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在更新…" })).toBeDisabled();
    await act(async () => pending.resolve());
  });

  it("clears only the current password after a network failure and never renders internals", async () => {
    const request = vi.fn<ChangePasswordRequest>().mockRejectedValue(
      new Error("socket failed with private-current"),
    );
    render(<SecurityPage changePassword={request} />);
    await fillValidForm();

    await userEvent.click(screen.getByRole("button", { name: "修改密码" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("网络连接失败，请重试");
    expect(screen.getByRole("alert")).not.toHaveTextContent("socket failed");
    expect(screen.getByRole("alert")).not.toHaveTextContent("private-current");
    expect(screen.getByLabelText("当前密码")).toHaveValue("");
    expect(screen.getByLabelText("新密码")).toHaveValue("replacement-secret");
    expect(screen.getByLabelText("确认新密码")).toHaveValue("replacement-secret");
  });

  it("honors Retry-After and gates every resubmit until the countdown expires", async () => {
    vi.useFakeTimers();
    const request = vi.fn<ChangePasswordRequest>()
      .mockRejectedValueOnce(new ClientApiError(
        429,
        "RATE_LIMITED",
        "请求过于频繁，请稍后重试",
        "01RATE",
        undefined,
        2,
      ))
      .mockResolvedValueOnce();
    render(<SecurityPage changePassword={request} />);
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "current-secret" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "replacement-secret" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "replacement-secret" } });
    fireEvent.submit(screen.getByRole("button", { name: "修改密码" }).closest("form")!);
    await flushPromises();

    const button = screen.getByRole("button", { name: "2 秒后重试" });
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest("form")!);
    fireEvent.submit(button.closest("form")!);
    expect(request).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("button", { name: "1 秒后重试" })).toBeDisabled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("button", { name: "修改密码" })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "current-secret" } });
    fireEvent.submit(screen.getByRole("button", { name: "修改密码" }).closest("form")!);
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["resolve", "reject"] as const)(
    "aborts and ignores a stale %s after unmount",
    async (outcome) => {
      const pending = deferred<void>();
      const request = vi.fn<ChangePasswordRequest>(() => pending.promise);
      const view = render(<SecurityPage changePassword={request} />);
      await fillValidForm();
      await userEvent.click(screen.getByRole("button", { name: "修改密码" }));
      const signal = request.mock.calls[0]?.[2];

      view.unmount();
      expect(signal?.aborted).toBe(true);
      await act(async () => {
        if (outcome === "resolve") pending.resolve();
        else pending.reject(new TypeError("late failure"));
        await pending.promise.catch(() => undefined);
      });
    },
  );
});

async function fillValidForm() {
  await userEvent.type(screen.getByLabelText("当前密码"), "current-secret");
  await userEvent.type(screen.getByLabelText("新密码"), "replacement-secret");
  await userEvent.type(screen.getByLabelText("确认新密码"), "replacement-secret");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
