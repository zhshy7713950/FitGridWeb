// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useUnsavedChangesGuard } from "./use-unsaved-changes-guard";

const message = "尚有未保存的修改，确定离开吗？";

beforeEach(() => {
  window.history.replaceState({ route: "form" }, "", "/grids/new");
});

afterEach(() => {
  cleanup();
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

  it("restores the guarded history entry when browser back is declined", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const forward = vi.spyOn(window.history, "forward").mockImplementation(() => undefined);
    renderHook(() => useUnsavedChangesGuard(true));

    window.dispatchEvent(new PopStateEvent("popstate", { state: { route: "form" } }));

    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("continues to the preceding history entry when browser back is confirmed", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    renderHook(() => useUnsavedChangesGuard(true));

    window.dispatchEvent(new PopStateEvent("popstate", { state: { route: "form" } }));

    expect(back).toHaveBeenCalledTimes(1);
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
});
