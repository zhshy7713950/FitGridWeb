// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ClientApiError } from "@/lib/api-client";

import type { ManagedUser, ManagedUserPage } from "./types";
import { useAdminUsers } from "./use-admin-users";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function managedUser(
  id: string,
  status: ManagedUser["status"] = "active",
): ManagedUser {
  return {
    id,
    username: id,
    role: id.startsWith("admin") ? "admin" : "member",
    status,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("loads once on mount without polling or restarting when its caller rerenders", async () => {
  vi.useFakeTimers();
  const list = vi.fn().mockResolvedValue({ items: [managedUser("admin-1")], nextCursor: "c2" });
  const { result, rerender } = renderHook(
    ({ marker }) => {
      void marker;
      return useAdminUsers({ list });
    },
    { initialProps: { marker: 0 } },
  );

  await act(async () => {});
  expect(result.current.items.map((user) => user.id)).toEqual(["admin-1"]);
  expect(result.current.nextCursor).toBe("c2");
  expect(list).toHaveBeenCalledWith({ limit: 20, signal: expect.any(AbortSignal) });

  rerender({ marker: 1 });
  act(() => vi.advanceTimersByTime(60 * 60 * 1000));
  expect(list).toHaveBeenCalledTimes(1);
});

it("aborts and ignores a late initial completion after unmount", async () => {
  const pending = deferred<ManagedUserPage>();
  let signal: AbortSignal | undefined;
  const list = vi.fn((input?: { signal?: AbortSignal }) => {
    signal = input?.signal;
    return pending.promise;
  });
  const { result, unmount } = renderHook(() => useAdminUsers({ list }));

  unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve({ items: [managedUser("late")], nextCursor: null }));
  expect(result.current.items).toEqual([]);
});

it("deduplicates cursor pages and suppresses rapid duplicate loads", async () => {
  const page = deferred<ManagedUserPage>();
  const list = vi.fn()
    .mockResolvedValueOnce({ items: [managedUser("member-1")], nextCursor: "c2" })
    .mockImplementationOnce(() => page.promise);
  const { result } = renderHook(() => useAdminUsers({ list }));
  await waitFor(() => expect(result.current.nextCursor).toBe("c2"));

  await act(async () => {
    const first = result.current.loadMore();
    const duplicate = result.current.loadMore();
    expect(list).toHaveBeenCalledTimes(2);
    page.resolve({
      items: [managedUser("member-1"), managedUser("member-2")],
      nextCursor: null,
    });
    await Promise.all([first, duplicate]);
  });

  expect(result.current.items.map((user) => user.id)).toEqual(["member-1", "member-2"]);
});

it("retains the ledger and retries the same cursor with a public request ID", async () => {
  const list = vi.fn()
    .mockResolvedValueOnce({ items: [managedUser("member-1")], nextCursor: "c2" })
    .mockRejectedValueOnce(new ClientApiError(503, "UNAVAILABLE", "暂不可用", "01PAGE"))
    .mockResolvedValueOnce({ items: [managedUser("member-2")], nextCursor: null });
  const { result } = renderHook(() => useAdminUsers({ list }));
  await waitFor(() => expect(result.current.nextCursor).toBe("c2"));

  await act(async () => result.current.loadMore());
  expect(result.current.items.map((user) => user.id)).toEqual(["member-1"]);
  expect(result.current.pageError).toEqual({
    status: 503,
    code: "UNAVAILABLE",
    message: "暂不可用",
    requestId: "01PAGE",
    retryAfterSeconds: undefined,
  });

  await act(async () => result.current.retryPage());
  expect(list.mock.calls[2][0]).toMatchObject({ cursor: "c2", limit: 20 });
  expect(result.current.items.map((user) => user.id)).toEqual(["member-1", "member-2"]);
});

it("shows an explicit initial error and retries without polling", async () => {
  const list = vi.fn()
    .mockRejectedValueOnce(new TypeError("private network details"))
    .mockResolvedValueOnce({ items: [], nextCursor: null });
  const { result } = renderHook(() => useAdminUsers({ list }));
  await waitFor(() => expect(result.current.initialError).toEqual({
    message: "网络连接失败，请重试",
  }));

  await act(async () => result.current.retryInitial());

  expect(list).toHaveBeenCalledTimes(2);
  expect(result.current.initialError).toBeNull();
  expect(result.current.initialLoading).toBe(false);
});

it("preserves a structured 403 response for the authority UI", async () => {
  const list = vi.fn().mockRejectedValue(new ClientApiError(
    403,
    "ADMIN_REQUIRED",
    "需要管理员权限",
    "01DENIED",
  ));
  const { result } = renderHook(() => useAdminUsers({ list }));

  await waitFor(() => expect(result.current.initialError).toEqual({
    status: 403,
    code: "ADMIN_REQUIRED",
    message: "需要管理员权限",
    requestId: "01DENIED",
    retryAfterSeconds: undefined,
  }));
});

it("preserves Retry-After, counts down, and blocks initial retries until it expires", async () => {
  vi.useFakeTimers();
  const list = vi.fn()
    .mockRejectedValueOnce(new ClientApiError(
      429,
      "RATE_LIMITED",
      "请求过于频繁",
      "01RATE",
      undefined,
      2,
    ))
    .mockResolvedValueOnce({ items: [], nextCursor: null });
  const { result } = renderHook(() => useAdminUsers({ list }));
  await act(async () => {});

  expect(result.current.initialError).toMatchObject({
    status: 429,
    message: "请求过于频繁",
    requestId: "01RATE",
    retryAfterSeconds: 2,
  });
  await act(async () => result.current.retryInitial());
  expect(list).toHaveBeenCalledTimes(1);

  act(() => vi.advanceTimersByTime(1_000));
  expect(result.current.initialError?.retryAfterSeconds).toBe(1);
  await act(async () => result.current.retryInitial());
  expect(list).toHaveBeenCalledTimes(1);

  act(() => vi.advanceTimersByTime(1_000));
  await act(async () => result.current.retryInitial());
  expect(list).toHaveBeenCalledTimes(2);
  expect(result.current.initialError).toBeNull();
});

it("blocks retrying a rate-limited cursor while keeping loaded rows", async () => {
  vi.useFakeTimers();
  const list = vi.fn()
    .mockResolvedValueOnce({ items: [managedUser("member-1")], nextCursor: "c2" })
    .mockRejectedValueOnce(new ClientApiError(
      429,
      "RATE_LIMITED",
      "翻页过于频繁",
      "01PAGE429",
      undefined,
      2,
    ))
    .mockResolvedValueOnce({ items: [managedUser("member-2")], nextCursor: null });
  const { result } = renderHook(() => useAdminUsers({ list }));
  await act(async () => {});

  await act(async () => result.current.loadMore());
  expect(result.current.items.map((user) => user.id)).toEqual(["member-1"]);
  expect(result.current.pageError?.retryAfterSeconds).toBe(2);
  await act(async () => result.current.retryPage());
  expect(list).toHaveBeenCalledTimes(2);

  act(() => vi.advanceTimersByTime(2_000));
  await act(async () => result.current.retryPage());
  expect(list).toHaveBeenCalledTimes(3);
  expect(result.current.items.map((user) => user.id)).toEqual(["member-1", "member-2"]);
});

it("updates only the server-returned target row and does not mutate on failure", async () => {
  const list = vi.fn().mockResolvedValue({
    items: [managedUser("admin-1"), managedUser("member-1")],
    nextCursor: null,
  });
  const update = vi.fn()
    .mockResolvedValueOnce({ ...managedUser("member-1", "disabled"), username: "server-member" })
    .mockRejectedValueOnce(new ClientApiError(
      409,
      "LAST_ACTIVE_ADMIN",
      "不能禁用最后一个有效管理员",
      "01LAST",
    ));
  const { result } = renderHook(() => useAdminUsers({ list, update }));
  await waitFor(() => expect(result.current.items).toHaveLength(2));

  await act(async () => {
    await result.current.updateStatus("member-1", "disabled");
  });
  expect(result.current.items).toEqual([
    managedUser("admin-1"),
    { ...managedUser("member-1", "disabled"), username: "server-member" },
  ]);

  await expect(result.current.updateStatus("admin-1", "disabled")).rejects.toMatchObject({
    code: "LAST_ACTIVE_ADMIN",
    requestId: "01LAST",
  });
  expect(result.current.items[0]).toEqual(managedUser("admin-1"));
});

it("prevents an older cursor response from overwriting a newer status response", async () => {
  const oldPage = deferred<ManagedUserPage>();
  const list = vi.fn()
    .mockResolvedValueOnce({ items: [managedUser("member-1")], nextCursor: "c2" })
    .mockImplementationOnce(() => oldPage.promise);
  const update = vi.fn().mockResolvedValue(managedUser("member-1", "disabled"));
  const { result } = renderHook(() => useAdminUsers({ list, update }));
  await waitFor(() => expect(result.current.nextCursor).toBe("c2"));

  let paging!: Promise<void>;
  act(() => {
    paging = result.current.loadMore();
  });
  await act(async () => result.current.updateStatus("member-1", "disabled"));
  await act(async () => {
    oldPage.resolve({
      items: [managedUser("member-1", "active"), managedUser("member-2")],
      nextCursor: null,
    });
    await paging;
  });

  expect(result.current.items).toEqual([
    managedUser("member-1", "disabled"),
    managedUser("member-2"),
  ]);
});
