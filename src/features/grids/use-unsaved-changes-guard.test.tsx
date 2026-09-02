// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useUnsavedChangesGuard } from "./use-unsaved-changes-guard";

const message = "尚有未保存的修改，确定离开吗？";

async function backOnce() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
      window.history.back();
    });
  });
}

function seedHistory(caseId: string) {
  window.history.replaceState({ route: "before" }, "", `/grids?case=${caseId}`);
  window.history.pushState({ route: "form" }, "", `/grids/new?case=${caseId}`);
}

beforeEach(() => {
  window.history.replaceState({ route: "form" }, "", "/grids/new");
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  });
  vi.restoreAllMocks();
});

describe("useUnsavedChangesGuard", () => {
  it("blocks a same-origin anchor navigation when dirty navigation is declined", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderHook(() => useUnsavedChangesGuard(true));
    const anchor = document.createElement("a");
    anchor.href = "/grids";
    document.body.append(anchor);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });

    anchor.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(confirm).toHaveBeenCalledWith(message);
    anchor.remove();
  });

  it("restores the guarded history entry when browser back is declined", async () => {
    seedHistory("declined");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderHook(() => useUnsavedChangesGuard(true));

    await backOnce();
    await waitFor(() => expect(window.location.pathname).toBe("/grids/new"));

    expect(window.location.search).toBe("?case=declined");
    expect(confirm).toHaveBeenCalledWith(message);
  });

  it("continues to the preceding history entry when browser back is confirmed", async () => {
    seedHistory("confirmed");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderHook(() => useUnsavedChangesGuard(true));

    await backOnce();
    await waitFor(() => expect(window.location.pathname).toBe("/grids"));

    expect(window.location.search).toBe("?case=confirmed");
    expect(confirm).toHaveBeenCalledWith(message);
  });

  it("does not guard unload or browser history while clean", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const forward = vi.spyOn(window.history, "forward").mockImplementation(() => undefined);
    renderHook(() => useUnsavedChangesGuard(false));
    const unload = new Event("beforeunload", { cancelable: true });

    window.dispatchEvent(unload);
    window.dispatchEvent(new PopStateEvent("popstate", { state: { route: "form" } }));

    expect(unload.defaultPrevented).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("retires its same-url buffer when dirty becomes clean", async () => {
    seedHistory("clean");
    const { rerender } = renderHook(
      ({ dirty }) => useUnsavedChangesGuard(dirty),
      { initialProps: { dirty: true } },
    );

    rerender({ dirty: false });
    await waitFor(() => expect(window.history.state).toEqual({ route: "form" }));
    await backOnce();

    expect(window.location.pathname).toBe("/grids");
    expect(window.location.search).toBe("?case=clean");
  });

  it("consumes the buffer on confirmed anchor navigation", async () => {
    seedHistory("anchor");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { unmount } = renderHook(() => useUnsavedChangesGuard(true));
    const anchor = document.createElement("a");
    anchor.href = "/grids?case=target";
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      window.history.pushState({ route: "target" }, "", anchor.href);
    });
    document.body.append(anchor);

    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    unmount();
    await backOnce();
    expect(window.location.pathname).toBe("/grids/new");
    await backOnce();

    expect(window.location.pathname).toBe("/grids");
    expect(window.location.search).toBe("?case=anchor");
    expect(confirm).toHaveBeenCalledWith(message);
    anchor.remove();
  });

  it("consumes the buffer on a successful programmatic route", async () => {
    seedHistory("programmatic");
    const { unmount } = renderHook(() => useUnsavedChangesGuard(true));

    window.history.pushState({ route: "detail" }, "", "/grids/grid-1");
    unmount();
    await backOnce();
    expect(window.location.pathname).toBe("/grids/new");
    await backOnce();

    expect(window.location.pathname).toBe("/grids");
    expect(window.location.search).toBe("?case=programmatic");
  });
});
