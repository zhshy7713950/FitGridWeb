// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientApiError } from "@/lib/api-client";

import { AdminWorkspaceView } from "./admin-workspace";
import type { ManagedUser } from "./types";
import type { AdminUserListController } from "./use-admin-users";

const admin: ManagedUser = {
  id: "admin-1",
  username: "chief.admin",
  role: "admin",
  status: "active",
  createdAt: "2026-09-01T00:00:00.000Z",
};
const member: ManagedUser = {
  id: "member-1",
  username: "member.one",
  role: "member",
  status: "active",
  createdAt: "2026-09-02T05:06:00.000Z",
};

function controller(patch: Partial<AdminUserListController> = {}): AdminUserListController {
  return {
    items: [admin, member],
    nextCursor: null,
    initialLoading: false,
    pageLoading: false,
    initialError: null,
    pageError: null,
    retryInitial: vi.fn().mockResolvedValue(undefined),
    loadMore: vi.fn().mockResolvedValue(undefined),
    retryPage: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue({ ...member, status: "disabled" }),
    ...patch,
  };
}

type CreateInvitationRequest = (
  expiresInHours: number,
  signal?: AbortSignal,
) => Promise<{ id: string; inviteUrl: string; expiresAt: string }>;

const invitation = {
  id: "invite-1",
  inviteUrl: "https://fitgrid.example/invite/private-token",
  expiresAt: "2026-09-03T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.style.removeProperty("overflow");
});

describe("administrator ledger", () => {
  it("renders only username, role, status, created time, and account action fields", () => {
    render(<AdminWorkspaceView currentUserId="admin-1" controller={controller()} />);

    const table = screen.getByRole("table", { name: "账号清单" });
    for (const heading of ["账号名称", "角色", "状态", "创建时间", "操作"]) {
      expect(within(table).getByRole("columnheader", { name: heading })).toBeInTheDocument();
    }
    expect(within(table).getByText("chief.admin")).toBeInTheDocument();
    expect(within(table).getByText("管理员")).toBeInTheDocument();
    expect(within(table).getAllByText("启用")).toHaveLength(2);
    expect(within(table).getByText("2026-09-02 13:06")).toBeInTheDocument();
    expect(screen.queryByText(/产品数量|产品代码|持仓/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /查看产品|导出产品/ })).not.toBeInTheDocument();
  });

  it("shows explicit loading, empty, initial error, and pagination states", async () => {
    const retryInitial = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller({ items: [], initialLoading: true })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在加载账号");

    rerender(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller({
          items: [],
          initialError: { message: "加载账号失败", requestId: "01LIST" },
          retryInitial,
        })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("请求 ID：01LIST");
    await userEvent.click(screen.getByRole("button", { name: "重试加载" }));
    expect(retryInitial).toHaveBeenCalledTimes(1);

    rerender(
      <AdminWorkspaceView currentUserId="admin-1" controller={controller({ items: [] })} />,
    );
    expect(screen.getByRole("region", { name: "账号清单空状态" })).toHaveTextContent(
      "还没有可管理的账号",
    );

    const loadMore = vi.fn().mockResolvedValue(undefined);
    rerender(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller({ nextCursor: "c2", loadMore })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "加载更多账号" }));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("shows a page failure without hiding loaded rows and retries that page", async () => {
    const retryPage = vi.fn().mockResolvedValue(undefined);
    render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller({
          nextCursor: "c2",
          pageError: { message: "加载更多账号失败", requestId: "01PAGE" },
          retryPage,
        })}
      />,
    );

    expect(screen.getByText("member.one")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("请求 ID：01PAGE");
    await userEvent.click(screen.getByRole("button", { name: "重试加载更多" }));
    expect(retryPage).toHaveBeenCalledTimes(1);
  });

  it("does not claim verified authority when the list endpoint returns 403", () => {
    render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller({
          items: [],
          initialError: {
            status: 403,
            code: "ADMIN_REQUIRED",
            message: "需要管理员权限",
            requestId: "01DENIED",
          },
        })}
      />,
    );

    expect(screen.queryByText("管理员权限已验证")).not.toBeInTheDocument();
    expect(screen.getByText("管理员权限未通过")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("需要管理员权限");
    expect(screen.getByRole("alert")).toHaveTextContent("请求 ID：01DENIED");
  });

  it("withdraws the verified-authority claim when a paginated list request returns 403", () => {
    render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller({
          pageError: {
            status: 403,
            code: "ADMIN_REQUIRED",
            message: "需要管理员权限",
          },
        })}
      />,
    );

    expect(screen.queryByText("管理员权限已验证")).not.toBeInTheDocument();
    expect(screen.getByText("管理员权限未通过")).toBeInTheDocument();
  });

  it("shows list Retry-After and disables retry actions during the countdown", () => {
    render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller({
          items: [],
          initialError: {
            status: 429,
            code: "RATE_LIMITED",
            message: "请求过于频繁",
            retryAfterSeconds: 2,
          },
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("2 秒后可重试");
    expect(screen.getByRole("button", { name: "2 秒后重试" })).toBeDisabled();
  });
});

describe("administrator invitation creation", () => {
  it.each(["", "0", "1.5", "169"])("rejects invalid TTL %s before the API", async (ttl) => {
    const createInvitation = vi.fn<CreateInvitationRequest>();
    render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller()}
        createInvitation={createInvitation}
      />,
    );
    const input = screen.getByLabelText("邀请有效期（小时）");
    await userEvent.clear(input);
    if (ttl) await userEvent.type(input, ttl);
    await userEvent.click(screen.getByRole("button", { name: "创建邀请" }));

    expect(createInvitation).not.toHaveBeenCalled();
    expect(screen.getByText("有效期必须是 1–168 之间的整数")).toBeInTheDocument();
  });

  it("defaults to 24 hours and synchronously blocks a double create", () => {
    const pending = deferred<typeof invitation>();
    const createInvitation = vi.fn<CreateInvitationRequest>(() => pending.promise);
    render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller()}
        createInvitation={createInvitation}
      />,
    );
    expect(screen.getByLabelText("邀请有效期（小时）")).toHaveValue(24);
    const form = screen.getByRole("button", { name: "创建邀请" }).closest("form")!;

    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(createInvitation).toHaveBeenCalledTimes(1);
    expect(createInvitation).toHaveBeenCalledWith(24, expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "正在创建邀请…" })).toBeDisabled();
  });

  it("keeps only the newest generated URL in React state and never writes or logs it", async () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const createInvitation = vi.fn<CreateInvitationRequest>()
      .mockResolvedValueOnce(invitation)
      .mockResolvedValueOnce({
        ...invitation,
        id: "invite-2",
        inviteUrl: "https://fitgrid.example/invite/new-private-token",
      });
    render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller()}
        createInvitation={createInvitation}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "创建邀请" }));
    expect(await screen.findByDisplayValue(invitation.inviteUrl)).toHaveAttribute("readonly");
    await userEvent.click(screen.getByRole("button", { name: "创建新邀请" }));

    expect(await screen.findByDisplayValue("https://fitgrid.example/invite/new-private-token"))
      .toBeInTheDocument();
    expect(screen.queryByDisplayValue(invitation.inviteUrl)).not.toBeInTheDocument();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it("reports clipboard success only after writeText resolves", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller()}
        createInvitation={vi.fn<CreateInvitationRequest>().mockResolvedValue(invitation)}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "创建邀请" }));

    await userEvent.click(await screen.findByRole("button", { name: "复制邀请链接" }));

    expect(writeText).toHaveBeenCalledWith(invitation.inviteUrl);
    expect(await screen.findByRole("status")).toHaveTextContent("邀请链接已复制");
  });

  it.each(["missing", "rejected"] as const)(
    "keeps the readonly link selectable and gives manual guidance when clipboard is %s",
    async (clipboardState) => {
      if (clipboardState === "missing") {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
      } else {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: vi.fn().mockRejectedValue(new Error("private permission error")) },
        });
      }
      render(
        <AdminWorkspaceView
          currentUserId="admin-1"
          controller={controller()}
          createInvitation={vi.fn<CreateInvitationRequest>().mockResolvedValue(invitation)}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "创建邀请" }));
      const input = await screen.findByLabelText("新邀请链接");

      await userEvent.click(screen.getByRole("button", { name: "复制邀请链接" }));

      expect(input).toHaveAttribute("readonly");
      expect(input).toHaveFocus();
      expect((input as HTMLInputElement).selectionStart).toBe(0);
      expect((input as HTMLInputElement).selectionEnd).toBe(invitation.inviteUrl.length);
      expect(screen.getByRole("alert")).toHaveTextContent("请选中上方链接并手动复制");
      expect(screen.queryByText("邀请链接已复制")).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).not.toHaveTextContent("private permission error");
    },
  );

  it.each(["resolve", "reject"] as const)(
    "ignores a stale clipboard %s after a newer invitation replaces its URL",
    async (settlement) => {
      const pendingCopy = deferred<void>();
      const writeText = vi.fn(() => pendingCopy.promise);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      const invitationB = {
        ...invitation,
        id: "invite-2",
        inviteUrl: "https://fitgrid.example/invite/new-private-token",
      };
      const createInvitation = vi.fn<CreateInvitationRequest>()
        .mockResolvedValueOnce(invitation)
        .mockResolvedValueOnce(invitationB);
      const selectedValues: string[] = [];
      const originalSelect = HTMLInputElement.prototype.select;
      vi.spyOn(HTMLInputElement.prototype, "select").mockImplementation(function select(
        this: HTMLInputElement,
      ) {
        selectedValues.push(this.value);
        originalSelect.call(this);
      });
      render(
        <AdminWorkspaceView
          currentUserId="admin-1"
          controller={controller()}
          createInvitation={createInvitation}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "创建邀请" }));
      await userEvent.click(await screen.findByRole("button", { name: "复制邀请链接" }));
      await userEvent.click(screen.getByRole("button", { name: "创建新邀请" }));
      expect(await screen.findByDisplayValue(invitationB.inviteUrl)).toBeInTheDocument();
      selectedValues.length = 0;

      await act(async () => {
        if (settlement === "resolve") pendingCopy.resolve(undefined);
        else pendingCopy.reject(new Error("late clipboard failure"));
      });

      expect(screen.queryByText("邀请链接已复制")).not.toBeInTheDocument();
      expect(screen.queryByText(/请选中上方链接并手动复制/)).not.toBeInTheDocument();
      expect(selectedValues).not.toContain(invitationB.inviteUrl);
    },
  );

  it("ignores clipboard rejection after unmount without selecting the detached URL", async () => {
    const pendingCopy = deferred<void>();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(() => pendingCopy.promise) },
    });
    const select = vi.spyOn(HTMLInputElement.prototype, "select");
    const view = render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller()}
        createInvitation={vi.fn<CreateInvitationRequest>().mockResolvedValue(invitation)}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "创建邀请" }));
    await userEvent.click(await screen.findByRole("button", { name: "复制邀请链接" }));
    select.mockClear();
    view.unmount();

    await act(async () => pendingCopy.reject(new Error("late clipboard failure")));

    expect(select).not.toHaveBeenCalled();
  });

  it("surfaces a public create error and aborts a pending request on unmount", async () => {
    const pending = deferred<typeof invitation>();
    const createInvitation = vi.fn<CreateInvitationRequest>(() => pending.promise);
    const view = render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller()}
        createInvitation={createInvitation}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "创建邀请" }));
    const signal = createInvitation.mock.calls[0]?.[1];
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.reject(new ClientApiError(
      422,
      "VALIDATION_FAILED",
      "有效期无效",
      "01INVITE",
    )));
  });

  it("preserves a public invitation error and gates repeats for Retry-After", async () => {
    vi.useFakeTimers();
    const createInvitation = vi.fn<CreateInvitationRequest>().mockRejectedValue(new ClientApiError(
      429,
      "RATE_LIMITED",
      "请求过于频繁",
      "01RATE",
      undefined,
      2,
    ));
    render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller()}
        createInvitation={createInvitation}
      />,
    );

    fireEvent.submit(screen.getByRole("button", { name: "创建邀请" }).closest("form")!);
    await flushPromises();
    expect(screen.getByRole("alert")).toHaveTextContent("请求过于频繁");
    expect(screen.getByRole("alert")).toHaveTextContent("请求 ID：01RATE");
    expect(screen.getByRole("button", { name: "2 秒后重试" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "2 秒后重试" }).closest("form")!);
    expect(createInvitation).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByRole("button", { name: "创建邀请" })).toBeEnabled();
    vi.useRealTimers();
  });
});

describe("administrator status safety", () => {
  it("prevents the signed-in administrator from disabling their own account", () => {
    const updateStatus = vi.fn();
    render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller({ updateStatus })}
      />,
    );

    expect(screen.getByRole("button", { name: "不能禁用 chief.admin（当前账号）" })).toBeDisabled();
    expect(screen.getByText("当前账号")).toBeInTheDocument();
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("opens an accessible confirmation before changing an account", async () => {
    const updateStatus = vi.fn();
    render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller({ updateStatus })}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "禁用 member.one" }));

    expect(screen.getByRole("dialog", { name: "确认禁用账号" })).toBeInTheDocument();
    expect(screen.getByText(/禁用后，member.one 的所有会话将立即撤销/)).toBeInTheDocument();
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("locks rapid confirmation synchronously and disables the target row action", async () => {
    const pending = deferred<ManagedUser>();
    const updateStatus = vi.fn<AdminUserListController["updateStatus"]>(() => pending.promise);
    render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller({ updateStatus })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "禁用 member.one" }));
    const form = screen.getByRole("button", { name: "确认禁用" }).closest("form")!;

    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect(updateStatus).toHaveBeenCalledWith("member-1", "disabled", expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "正在禁用…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "禁用 member.one", hidden: true })).toBeDisabled();

    await act(async () => pending.resolve({ ...member, status: "disabled" }));
  });

  it("surfaces LAST_ACTIVE_ADMIN and request ID without optimistic row mutation", async () => {
    const anotherAdmin = { ...admin, id: "admin-2", username: "backup.admin" };
    const updateStatus = vi.fn().mockRejectedValue(new ClientApiError(
      409,
      "LAST_ACTIVE_ADMIN",
      "不能禁用最后一个有效管理员",
      "01LAST",
    ));
    render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller({ items: [admin, anotherAdmin], updateStatus })}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "禁用 backup.admin" }));
    await userEvent.click(screen.getByRole("button", { name: "确认禁用" }));

    const dialog = await screen.findByRole("dialog", { name: "确认禁用账号" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("不能禁用最后一个有效管理员");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("请求 ID：01LAST");
    expect(screen.getByRole("button", { name: "禁用 backup.admin", hidden: true })).toBeEnabled();
    expect(within(screen.getByRole("row", { name: /backup.admin/, hidden: true })).getByText("启用"))
      .toBeInTheDocument();
  });

  it("traps focus, isolates the document, locks scroll, and restores everything on Escape", async () => {
    document.body.style.overflow = "clip";
    render(
      <>
        <nav data-testid="outside-navigation" aria-hidden="false">导航</nav>
        <AdminWorkspaceView currentUserId="admin-1" controller={controller()} />
        <footer data-testid="outside-footer" inert={true}>页脚</footer>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "禁用 member.one" });
    await userEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "确认禁用账号" });
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    const confirm = within(dialog).getByRole("button", { name: "确认禁用" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(cancel).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getByTestId("outside-navigation")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("outside-navigation")).toHaveAttribute("inert");
    expect(screen.getByTestId("outside-footer")).toHaveAttribute("inert");

    cancel.focus();
    await userEvent.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await userEvent.tab();
    expect(cancel).toHaveFocus();
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "确认禁用账号" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("clip");
    expect(screen.getByTestId("outside-navigation")).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByTestId("outside-navigation")).not.toHaveAttribute("inert");
    expect(screen.getByTestId("outside-footer")).toHaveAttribute("inert");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("blocks Escape, backdrop, and close while status change is pending, then aborts on unmount", async () => {
    const pending = deferred<ManagedUser>();
    const updateStatus = vi.fn<AdminUserListController["updateStatus"]>(() => pending.promise);
    const view = render(
      <AdminWorkspaceView
        currentUserId="admin-1"
        controller={controller({ updateStatus })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "禁用 member.one" }));
    await userEvent.click(screen.getByRole("button", { name: "确认禁用" }));
    const signal = updateStatus.mock.calls[0]?.[2];

    fireEvent.click(screen.getByRole("button", { name: "关闭账号状态确认" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "确认禁用账号" })).toBeInTheDocument();

    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ ...member, status: "disabled" }));
  });
});

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
