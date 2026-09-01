// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ClientApiError } from "@/lib/api-client";

import { useGridTrades } from "./use-grid-trades";
import type { GridTradePage, GridTradeSummary } from "./types";

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

function item(id: string): GridTradeSummary {
  return {
    id,
    productName: id,
    productCode: id,
    maxPrice: "1",
    perShare: "2000",
    isShort: false,
    algorithmVersion: "android-v2.1.0",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("loads the first unfiltered page on mount", async () => {
  const request = vi.fn().mockResolvedValue({ items: [item("first")], nextCursor: "c2" });
  const { result } = renderHook(() => useGridTrades({ request }));

  expect(result.current.initialLoading).toBe(true);
  await waitFor(() => expect(result.current.items.map((entry) => entry.id)).toEqual(["first"]));

  expect(request).toHaveBeenCalledWith({ q: undefined, signal: expect.any(AbortSignal) });
  expect(result.current.nextCursor).toBe("c2");
  expect(result.current.initialLoading).toBe(false);
});

it("waits 250ms for search and ignores an aborted older response", async () => {
  vi.useFakeTimers();
  const requests = new Map<string, Deferred<GridTradePage>>();
  const request = vi.fn((input?: { q?: string; cursor?: string; signal?: AbortSignal }) => {
    const { q = "" } = input ?? {};
    const pending = deferred<GridTradePage>();
    requests.set(q, pending);
    return pending.promise;
  });
  const { result } = renderHook(() => useGridTrades({ request }));

  act(() => result.current.setQuery("gold"));
  act(() => vi.advanceTimersByTime(249));
  expect(request).toHaveBeenCalledTimes(1);

  act(() => vi.advanceTimersByTime(1));
  expect(request).toHaveBeenCalledTimes(2);
  const goldSignal = request.mock.calls[1][0]?.signal;

  act(() => result.current.setQuery("oil"));
  act(() => vi.advanceTimersByTime(250));
  expect(request).toHaveBeenCalledTimes(3);
  expect(goldSignal?.aborted).toBe(true);

  await act(async () => {
    requests.get("oil")!.resolve({ items: [item("oil")], nextCursor: null });
  });
  await act(async () => {
    requests.get("gold")!.resolve({ items: [item("gold")], nextCursor: null });
  });

  expect(result.current.items.map((entry) => entry.id)).toEqual(["oil"]);
});

it("clears the query with an immediate unfiltered request and resets stale pagination", async () => {
  vi.useFakeTimers();
  const cleared = deferred<GridTradePage>();
  const request = vi.fn()
    .mockResolvedValueOnce({ items: [item("initial")], nextCursor: null })
    .mockResolvedValueOnce({ items: [item("gold")], nextCursor: "gold-c2" })
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(() => cleared.promise);
  const { result } = renderHook(() => useGridTrades({ request }));

  await act(async () => {});
  act(() => result.current.setQuery("gold"));
  act(() => vi.advanceTimersByTime(250));
  await act(async () => {});
  await act(async () => result.current.loadMore());
  expect(result.current.pageError).toBe("加载更多失败");
  expect(result.current.nextCursor).toBe("gold-c2");

  act(() => result.current.clearQuery());

  expect(request).toHaveBeenCalledTimes(4);
  expect(request.mock.calls[3][0]).toMatchObject({ q: undefined });
  expect(result.current.query).toBe("");
  expect(result.current.items).toEqual([]);
  expect(result.current.nextCursor).toBeNull();
  expect(result.current.pageError).toBe("");

  act(() => vi.advanceTimersByTime(249));
  expect(request).toHaveBeenCalledTimes(4);
  await act(async () => {
    cleared.resolve({ items: [item("all")], nextCursor: null });
  });
  expect(result.current.items.map((entry) => entry.id)).toEqual(["all"]);
});

it("retains visible items and exposes a request ID when refresh fails", async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ items: [item("visible")], nextCursor: "c2" })
    .mockRejectedValueOnce(new ClientApiError(503, "UNAVAILABLE", "不可用", "01REFRESH"));
  const { result } = renderHook(() => useGridTrades({ request }));
  await waitFor(() => expect(result.current.items).toHaveLength(1));

  await act(async () => result.current.refresh());

  expect(result.current.items.map((entry) => entry.id)).toEqual(["visible"]);
  expect(result.current.initialError).toBe("加载产品失败，请求 ID：01REFRESH");
});

it("coalesces repeated refresh while retained data is still refreshing", async () => {
  const refreshed = deferred<GridTradePage>();
  const request = vi.fn()
    .mockResolvedValueOnce({ items: [item("visible")], nextCursor: null })
    .mockImplementationOnce(() => refreshed.promise)
    .mockResolvedValueOnce({ items: [item("refreshed-again")], nextCursor: null });
  const { result } = renderHook(() => useGridTrades({ request }));
  await waitFor(() => expect(result.current.items).toHaveLength(1));

  let firstRefresh!: Promise<void>;
  let duplicateRefresh!: Promise<void>;
  act(() => {
    firstRefresh = result.current.refresh();
    duplicateRefresh = result.current.refresh();
  });

  expect(request).toHaveBeenCalledTimes(2);
  expect(result.current.refreshing).toBe(true);

  await act(async () => {
    refreshed.resolve({ items: [item("refreshed")], nextCursor: null });
    await Promise.all([firstRefresh, duplicateRefresh]);
  });
  expect(result.current.refreshing).toBe(false);
  expect(result.current.items.map((entry) => entry.id)).toEqual(["refreshed"]);

  await act(async () => result.current.refresh());
  expect(request).toHaveBeenCalledTimes(3);
  expect(result.current.items.map((entry) => entry.id)).toEqual(["refreshed-again"]);
});

it("aborts an in-flight retained-data refresh when unmounted", async () => {
  const refreshed = deferred<GridTradePage>();
  let refreshSignal: AbortSignal | undefined;
  const request = vi.fn()
    .mockResolvedValueOnce({ items: [item("visible")], nextCursor: null })
    .mockImplementationOnce((input?: { signal?: AbortSignal }) => {
      refreshSignal = input?.signal;
      return refreshed.promise;
    });
  const { result, unmount } = renderHook(() => useGridTrades({ request }));
  await waitFor(() => expect(result.current.items).toHaveLength(1));

  let pendingRefresh!: Promise<void>;
  act(() => {
    pendingRefresh = result.current.refresh();
  });
  await waitFor(() => expect(refreshSignal).toBeInstanceOf(AbortSignal));

  unmount();
  expect(refreshSignal?.aborted).toBe(true);

  refreshed.resolve({ items: [item("late-refresh")], nextCursor: null });
  await pendingRefresh;
  expect(result.current.items.map((entry) => entry.id)).toEqual(["visible"]);
});

it("retains loaded items when a cursor fails and retries the same cursor", async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ items: [item("first")], nextCursor: "c2" })
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ items: [item("second")], nextCursor: null });
  const { result } = renderHook(() => useGridTrades({ request }));
  await waitFor(() => expect(result.current.items).toHaveLength(1));

  await act(async () => result.current.loadMore());
  expect(result.current.items.map((entry) => entry.id)).toEqual(["first"]);
  expect(result.current.pageError).toBe("加载更多失败");

  await act(async () => result.current.retryPage());
  expect(result.current.items.map((entry) => entry.id)).toEqual(["first", "second"]);
  expect(request.mock.calls[2][0].cursor).toBe("c2");
});

it("suppresses a duplicate request for the same in-flight cursor", async () => {
  const nextPage = deferred<GridTradePage>();
  const request = vi.fn()
    .mockResolvedValueOnce({ items: [item("first")], nextCursor: "c2" })
    .mockImplementationOnce(() => nextPage.promise);
  const { result } = renderHook(() => useGridTrades({ request }));
  await waitFor(() => expect(result.current.nextCursor).toBe("c2"));

  await act(async () => {
    const first = result.current.loadMore();
    const duplicate = result.current.loadMore();
    expect(request).toHaveBeenCalledTimes(2);
    nextPage.resolve({ items: [item("second")], nextCursor: null });
    await Promise.all([first, duplicate]);
  });

  expect(result.current.items.map((entry) => entry.id)).toEqual(["first", "second"]);
});

it("aborts an in-flight cursor request when unmounted", async () => {
  const nextPage = deferred<GridTradePage>();
  let cursorSignal: AbortSignal | undefined;
  const request = vi.fn()
    .mockResolvedValueOnce({ items: [item("first")], nextCursor: "c2" })
    .mockImplementationOnce((input?: { signal?: AbortSignal }) => {
      cursorSignal = input?.signal;
      return nextPage.promise;
    });
  const { result, unmount } = renderHook(() => useGridTrades({ request }));
  await waitFor(() => expect(result.current.nextCursor).toBe("c2"));

  let pendingPage!: Promise<void>;
  act(() => {
    pendingPage = result.current.loadMore();
  });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));

  unmount();
  expect(cursorSignal).toBeInstanceOf(AbortSignal);
  expect(cursorSignal?.aborted).toBe(true);

  nextPage.resolve({ items: [item("late-page")], nextCursor: null });
  await pendingPage;
  expect(result.current.items.map((entry) => entry.id)).toEqual(["first"]);
});

it("keeps a cursor owned across refresh until the older request settles", async () => {
  const olderPage = deferred<GridTradePage>();
  const currentPage = deferred<GridTradePage>();
  const request = vi.fn()
    .mockResolvedValueOnce({ items: [item("first")], nextCursor: "c2" })
    .mockImplementationOnce(() => olderPage.promise)
    .mockResolvedValueOnce({ items: [item("refreshed")], nextCursor: "c2" })
    .mockImplementationOnce(() => currentPage.promise);
  const { result } = renderHook(() => useGridTrades({ request }));
  await waitFor(() => expect(result.current.nextCursor).toBe("c2"));

  let olderLoad!: Promise<void>;
  act(() => {
    olderLoad = result.current.loadMore();
  });
  await act(async () => result.current.refresh());
  expect(result.current.items.map((entry) => entry.id)).toEqual(["refreshed"]);

  let suppressedLoad!: Promise<void>;
  act(() => {
    suppressedLoad = result.current.loadMore();
  });
  expect(request).toHaveBeenCalledTimes(3);
  await suppressedLoad;

  await act(async () => {
    olderPage.resolve({ items: [item("stale")], nextCursor: null });
    await olderLoad;
  });
  expect(result.current.items.map((entry) => entry.id)).toEqual(["refreshed"]);

  let currentLoad!: Promise<void>;
  act(() => {
    currentLoad = result.current.loadMore();
  });
  expect(request).toHaveBeenCalledTimes(4);
  expect(request.mock.calls[3][0].cursor).toBe("c2");
  await act(async () => {
    currentPage.resolve({ items: [item("current")], nextCursor: null });
    await currentLoad;
  });
  expect(result.current.items.map((entry) => entry.id)).toEqual(["refreshed", "current"]);
});

it("does not append a late cursor page after a new query resolves", async () => {
  vi.useFakeTimers();
  const olderPage = deferred<GridTradePage>();
  const newQueryPage = deferred<GridTradePage>();
  const request = vi.fn()
    .mockResolvedValueOnce({ items: [item("first")], nextCursor: "c2" })
    .mockImplementationOnce(() => olderPage.promise)
    .mockImplementationOnce(() => newQueryPage.promise);
  const { result } = renderHook(() => useGridTrades({ request }));
  await act(async () => {});

  let olderLoad!: Promise<void>;
  act(() => {
    olderLoad = result.current.loadMore();
  });
  act(() => result.current.setQuery("oil"));
  act(() => vi.advanceTimersByTime(250));
  expect(request.mock.calls[2][0]).toMatchObject({ q: "oil" });

  await act(async () => {
    newQueryPage.resolve({ items: [item("oil")], nextCursor: null });
  });
  await act(async () => {
    olderPage.resolve({ items: [item("stale")], nextCursor: null });
    await olderLoad;
  });

  expect(result.current.items.map((entry) => entry.id)).toEqual(["oil"]);
});

it("includes the request ID in an initial service error", async () => {
  const request = vi.fn().mockRejectedValue(
    new ClientApiError(503, "UNAVAILABLE", "不可用", "01GRID"),
  );
  const { result } = renderHook(() => useGridTrades({ request }));

  await waitFor(() => {
    expect(result.current.initialError).toBe("加载产品失败，请求 ID：01GRID");
  });
});

it("maps a native fetch TypeError to the network message", async () => {
  const request = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
  const { result } = renderHook(() => useGridTrades({ request }));

  await waitFor(() => {
    expect(result.current.initialError).toBe("网络连接失败，请重试");
  });
});
