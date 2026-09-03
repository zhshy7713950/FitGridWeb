// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientApiError } from "@/lib/api-client";

import type { ImportPreview, ImportReport } from "./types";
import { useGridImport } from "./use-grid-import";

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

function preview(token: string, expiresAt = "2099-01-01T00:00:00.000Z"): ImportPreview {
  return {
    previewToken: token,
    expiresAt,
    creates: [{ index: 0, productCode: "SYNTHETIC-NEW" }],
    conflicts: [],
    invalid: [],
    warnings: [],
  };
}

const report: ImportReport = { created: 1, overwritten: 0, skipped: 0, invalid: 0 };

afterEach(() => vi.restoreAllMocks());

describe("file selection and preview", () => {
  it("starts at file selection and rejects an invalid file without calling the API", async () => {
    const previewRequest = vi.fn();
    const { result } = renderHook(() => useGridImport({ previewRequest }));

    await act(async () => result.current.selectFile(new File(["{}"], "data.txt")));

    expect(result.current.state).toEqual({ stage: "select", error: "请选择 JSON 文件" });
    expect(previewRequest).not.toHaveBeenCalled();
  });

  it("enters previewing synchronously and defaults a successful preview to skip", async () => {
    const pending = deferred<ImportPreview>();
    const previewRequest = vi.fn(() => pending.promise);
    const file = new File(["[]"], "SYNTHETIC.JSON", { type: "text/plain" });
    const { result } = renderHook(() => useGridImport({ previewRequest }));
    let selection!: Promise<void>;

    act(() => {
      selection = result.current.selectFile(file);
    });
    expect(result.current.state).toEqual({ stage: "previewing", filename: "SYNTHETIC.JSON" });
    expect(previewRequest).toHaveBeenCalledWith(file);

    await act(async () => {
      pending.resolve(preview("preview-token-one"));
      await selection;
    });
    expect(result.current.state).toMatchObject({
      stage: "preview",
      filename: "SYNTHETIC.JSON",
      policy: "skip",
      error: null,
    });
  });

  it("coalesces duplicate preview calls made before the first render update", async () => {
    const pending = deferred<ImportPreview>();
    const previewRequest = vi.fn(() => pending.promise);
    const file = new File(["[]"], "synthetic.json");
    const { result } = renderHook(() => useGridImport({ previewRequest }));
    let first!: Promise<void>;
    let duplicate!: Promise<void>;

    act(() => {
      first = result.current.selectFile(file);
      duplicate = result.current.selectFile(file);
    });

    expect(previewRequest).toHaveBeenCalledTimes(1);
    expect(duplicate).toBe(first);
    await act(async () => {
      pending.resolve(preview("preview-token-once"));
      await Promise.all([first, duplicate]);
    });
  });

  it("returns a preview API failure to selection with its public message and request ID", async () => {
    const previewRequest = vi.fn().mockRejectedValue(
      new ClientApiError(422, "IMPORT_FORMAT_INVALID", "导入文件格式无效", "req-preview-7"),
    );
    const { result } = renderHook(() => useGridImport({ previewRequest }));

    await act(async () => result.current.selectFile(new File(["[]"], "synthetic.json")));

    expect(result.current.state).toEqual({
      stage: "select",
      error: "导入文件格式无效，请求 ID：req-preview-7",
    });
  });

  it("lets a replacement file win and ignores the older preview completion", async () => {
    const first = deferred<ImportPreview>();
    const second = deferred<ImportPreview>();
    const previewRequest = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { result } = renderHook(() => useGridImport({ previewRequest }));
    let olderSelection!: Promise<void>;
    let newerSelection!: Promise<void>;

    act(() => {
      olderSelection = result.current.selectFile(new File(["[]"], "older.json"));
      newerSelection = result.current.selectFile(new File(["[]"], "newer.json"));
    });
    expect(previewRequest).toHaveBeenCalledTimes(2);
    expect(result.current.state).toEqual({ stage: "previewing", filename: "newer.json" });

    await act(async () => {
      second.resolve(preview("newer-token"));
      await newerSelection;
    });
    await act(async () => {
      first.resolve(preview("older-token"));
      await olderSelection;
    });

    expect(result.current.state).toMatchObject({
      stage: "preview",
      filename: "newer.json",
      preview: { previewToken: "newer-token" },
    });
  });

  it("ignores a preview completion after reset or unmount", async () => {
    const afterReset = deferred<ImportPreview>();
    const resetHook = renderHook(() => useGridImport({ previewRequest: () => afterReset.promise }));
    let resetSelection!: Promise<void>;
    act(() => {
      resetSelection = resetHook.result.current.selectFile(new File(["[]"], "reset.json"));
      resetHook.result.current.reset();
    });
    await act(async () => {
      afterReset.resolve(preview("stale-after-reset"));
      await resetSelection;
    });
    expect(resetHook.result.current.state).toEqual({ stage: "select", error: null });

    const afterUnmount = deferred<ImportPreview>();
    const unmountedHook = renderHook(() => useGridImport({ previewRequest: () => afterUnmount.promise }));
    let unmountedSelection!: Promise<void>;
    act(() => {
      unmountedSelection = unmountedHook.result.current.selectFile(
        new File(["[]"], "unmounted.json"),
      );
    });
    unmountedHook.unmount();
    afterUnmount.resolve(preview("stale-after-unmount"));
    await unmountedSelection;
    expect(unmountedHook.result.current.state).toEqual({
      stage: "previewing",
      filename: "unmounted.json",
    });
  });
});

describe("commit", () => {
  it("uses a synchronously selected policy and coalesces duplicate commits", async () => {
    const committed = deferred<ImportReport>();
    const commitRequest = vi.fn(() => committed.promise);
    const { result } = renderHook(() => useGridImport({
      previewRequest: vi.fn().mockResolvedValue(preview("commit-token")),
      commitRequest,
    }));
    await act(async () => result.current.selectFile(new File(["[]"], "synthetic.json")));
    let first!: Promise<void>;
    let duplicate!: Promise<void>;

    act(() => {
      result.current.setPolicy("overwrite");
      first = result.current.commit();
      duplicate = result.current.commit();
    });

    expect(commitRequest).toHaveBeenCalledTimes(1);
    expect(commitRequest).toHaveBeenCalledWith("commit-token", "overwrite");
    expect(duplicate).toBe(first);
    expect(result.current.state).toMatchObject({ stage: "committing", policy: "overwrite" });

    await act(async () => {
      committed.resolve(report);
      await Promise.all([first, duplicate]);
    });
    expect(result.current.state).toEqual({ stage: "complete", report });
  });

  it("refuses an expired preview at equality and returns to a clear reselect path", async () => {
    const expiresAt = "2026-09-02T00:15:00.000Z";
    const commitRequest = vi.fn();
    const { result } = renderHook(() => useGridImport({
      previewRequest: vi.fn().mockResolvedValue(preview("expired-token", expiresAt)),
      commitRequest,
      now: () => new Date(expiresAt),
    }));
    await act(async () => result.current.selectFile(new File(["[]"], "expired.json")));

    await act(async () => result.current.commit("skip"));

    expect(commitRequest).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({
      stage: "select",
      error: "导入预检已过期，请重新选择文件",
    });
  });

  it("retains the preview and policy with a public error so commit can be retried", async () => {
    const commitRequest = vi.fn()
      .mockRejectedValueOnce(new ClientApiError(503, "UNAVAILABLE", "导入服务暂不可用", "req-commit-8"))
      .mockResolvedValueOnce(report);
    const { result } = renderHook(() => useGridImport({
      previewRequest: vi.fn().mockResolvedValue(preview("retry-token")),
      commitRequest,
    }));
    await act(async () => result.current.selectFile(new File(["[]"], "retry.json")));
    act(() => result.current.setPolicy("overwrite"));

    await act(async () => result.current.commit());

    expect(result.current.state).toMatchObject({
      stage: "preview",
      filename: "retry.json",
      policy: "overwrite",
      preview: { previewToken: "retry-token" },
      error: "导入服务暂不可用，请求 ID：req-commit-8",
    });

    await act(async () => result.current.commit());
    expect(commitRequest).toHaveBeenCalledTimes(2);
    expect(result.current.state).toEqual({ stage: "complete", report });
  });

  it("resets an unusable single-use preview after IMPORT_PREVIEW_NOT_FOUND", async () => {
    const commitRequest = vi.fn().mockRejectedValue(
      new ClientApiError(
        404,
        "IMPORT_PREVIEW_NOT_FOUND",
        "导入预检不存在、已过期或已使用",
        "req-token-9",
      ),
    );
    const { result } = renderHook(() => useGridImport({
      previewRequest: vi.fn().mockResolvedValue(preview("missing-token")),
      commitRequest,
    }));
    await act(async () => result.current.selectFile(new File(["[]"], "missing.json")));

    await act(async () => result.current.commit());

    expect(result.current.state).toEqual({
      stage: "select",
      error: "导入预检已过期或已使用，请重新选择文件，请求 ID：req-token-9",
    });
  });

  it("ignores a stale commit after reset and after a replacement selection", async () => {
    const firstCommit = deferred<ImportReport>();
    const replacementPreview = deferred<ImportPreview>();
    const previewRequest = vi.fn()
      .mockResolvedValueOnce(preview("first-token"))
      .mockImplementationOnce(() => replacementPreview.promise);
    const { result } = renderHook(() => useGridImport({
      previewRequest,
      commitRequest: () => firstCommit.promise,
    }));
    await act(async () => result.current.selectFile(new File(["[]"], "first.json")));
    let staleCommit!: Promise<void>;
    act(() => {
      staleCommit = result.current.commit();
      result.current.reset();
    });
    await act(async () => {
      firstCommit.resolve(report);
      await staleCommit;
    });
    expect(result.current.state).toEqual({ stage: "select", error: null });

    const secondCommit = deferred<ImportReport>();
    const secondPreviewRequest = vi.fn()
      .mockResolvedValueOnce(preview("second-first-token"))
      .mockImplementationOnce(() => replacementPreview.promise);
    const secondHook = renderHook(() => useGridImport({
      previewRequest: secondPreviewRequest,
      commitRequest: () => secondCommit.promise,
    }));
    await act(async () => secondHook.result.current.selectFile(new File(["[]"], "first.json")));
    let replacingCommit!: Promise<void>;
    let replacingSelection!: Promise<void>;
    act(() => {
      replacingCommit = secondHook.result.current.commit();
      replacingSelection = secondHook.result.current.selectFile(
        new File(["[]"], "replacement.json"),
      );
    });
    await act(async () => {
      secondCommit.resolve(report);
      await replacingCommit;
    });
    expect(secondHook.result.current.state).toEqual({
      stage: "previewing",
      filename: "replacement.json",
    });
    await act(async () => {
      replacementPreview.resolve(preview("replacement-token"));
      await replacingSelection;
    });
    expect(secondHook.result.current.state).toMatchObject({
      stage: "preview",
      filename: "replacement.json",
      preview: { previewToken: "replacement-token" },
    });
  });

  it("ignores a commit completion after unmount", async () => {
    const committed = deferred<ImportReport>();
    const hook = renderHook(() => useGridImport({
      previewRequest: vi.fn().mockResolvedValue(preview("unmount-token")),
      commitRequest: () => committed.promise,
    }));
    await act(async () => hook.result.current.selectFile(new File(["[]"], "unmount.json")));
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.commit();
    });
    hook.unmount();
    committed.resolve(report);
    await pending;
    expect(hook.result.current.state).toMatchObject({ stage: "committing" });
  });
});
