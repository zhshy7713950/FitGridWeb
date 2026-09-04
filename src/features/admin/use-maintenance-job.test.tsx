// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ClientApiError } from "@/lib/api-client";

import type { MaintenanceJobStatus } from "./types";
import { useMaintenanceJob } from "./use-maintenance-job";

const JOB_ID = "00000000-0000-4000-8000-000000000031";

function status(state: MaintenanceJobStatus["state"]): MaintenanceJobStatus {
  return {
    id: JOB_ID,
    type: "backup",
    state,
    requestId: "01JOB",
    updatedAt: "2026-09-03T07:00:00.000Z",
  };
}

function setDocumentVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setDocumentVisibility("visible");
});

it("polls immediately, once per second while visible, and every five seconds while hidden", async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockResolvedValue(status("dumping"));
  renderHook(() => useMaintenanceJob(JOB_ID, request));

  await act(async () => {});
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(request).toHaveBeenCalledTimes(4);
  act(() => setDocumentVisibility("hidden"));
  await act(async () => vi.advanceTimersByTimeAsync(4_999));
  expect(request).toHaveBeenCalledTimes(4);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(request).toHaveBeenCalledTimes(5);
});

it.each(["ready", "awaiting-confirmation", "succeeded", "failed", "intervention-required"] as const)(
  "stops its only timer after terminal state %s",
  async (terminal) => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue(status(terminal));
    const { result } = renderHook(() => useMaintenanceJob(JOB_ID, request));

    await act(async () => {});
    expect(result.current.job?.state).toBe(terminal);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("honors Retry-After without creating overlapping timers", async () => {
  vi.useFakeTimers();
  const request = vi.fn()
    .mockRejectedValueOnce(new ClientApiError(
      429,
      "RATE_LIMITED",
      "请求过于频繁",
      "01RATE",
      undefined,
      7,
    ))
    .mockResolvedValue(status("dumping"));
  const { result } = renderHook(() => useMaintenanceJob(JOB_ID, request));

  await act(async () => {});
  expect(result.current.error).toMatchObject({ message: "请求过于频繁", requestId: "01RATE" });
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => vi.advanceTimersByTimeAsync(6_999));
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(request).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
});

it("reports a transient disconnect and resumes polling the restore job", async () => {
  vi.useFakeTimers();
  const restoring = { ...status("restoring"), type: "restore" as const };
  const request = vi.fn()
    .mockResolvedValueOnce(restoring)
    .mockRejectedValueOnce(new TypeError("private network detail"))
    .mockResolvedValueOnce({ ...restoring, state: "succeeded" as const });
  const { result } = renderHook(() => useMaintenanceJob(JOB_ID, request));

  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(result.current.disconnected).toBe(true);
  expect(result.current.error?.message).toBe("与服务器的连接暂时中断");
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(result.current.job?.state).toBe("succeeded");
  expect(result.current.disconnected).toBe(false);
});

it("advances recovery generation for each offline or revoked-session probe episode", async () => {
  vi.useFakeTimers();
  const restoring = { ...status("restoring"), type: "restore" as const };
  const request = vi.fn()
    .mockRejectedValueOnce(new TypeError("first disconnect"))
    .mockResolvedValueOnce(restoring)
    .mockRejectedValueOnce(new ClientApiError(
      401,
      "SESSION_REVOKED",
      "会话已失效",
      "01REVOKED",
    ));
  const { result } = renderHook(() => useMaintenanceJob(JOB_ID, request));

  await act(async () => {});
  expect(result.current.recoveryGeneration).toBe(1);
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(result.current.disconnected).toBe(false);
  expect(result.current.recoveryGeneration).toBe(1);
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(result.current.error?.status).toBe(401);
  expect(result.current.recoveryGeneration).toBe(2);
});

it("aborts stale generations on ID change and unmount without rerender-triggered loops", async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const request = vi.fn((_id: string, signal?: AbortSignal) => {
    if (signal) signals.push(signal);
    return new Promise<MaintenanceJobStatus>(() => undefined);
  });
  const { rerender, unmount } = renderHook(
    ({ id, marker }) => {
      void marker;
      return useMaintenanceJob(id, request);
    },
    { initialProps: { id: JOB_ID as string | null, marker: 0 } },
  );

  await act(async () => {});
  expect(request).toHaveBeenCalledTimes(1);
  rerender({ id: JOB_ID, marker: 1 });
  expect(request).toHaveBeenCalledTimes(1);
  rerender({ id: "00000000-0000-4000-8000-000000000032", marker: 2 });
  expect(signals[0]?.aborted).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
  unmount();
  expect(signals[1]?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
