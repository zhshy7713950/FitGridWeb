// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, themeInitializationScript } from "./theme";
import { ThemeToggle } from "./theme-toggle";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
  document.head.innerHTML = '<meta name="theme-color" content="#F3F6FB"><meta name="color-scheme" content="light">';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("theme initialization", () => {
  it("creates browser metadata before hydration without duplicating it", () => {
    document.head.innerHTML = "";
    new Function(themeInitializationScript)();
    new Function(themeInitializationScript)();
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(document.querySelectorAll('meta[name="color-scheme"]')).toHaveLength(1);
  });

  it.each([null, "invalid", "light", "dark"])("restores %s before rendering page content", (saved) => {
    if (saved !== null) window.localStorage.setItem("fitgrid-theme", saved);
    new Function(themeInitializationScript)();
    const expected = saved === "dark" ? "dark" : "light";
    expect(document.documentElement.dataset.theme).toBe(expected);
    expect(document.documentElement.style.colorScheme).toBe(expected);
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", expected === "dark" ? "#0B0F14" : "#F3F6FB");
    expect(document.querySelector('meta[name="color-scheme"]')).toHaveAttribute("content", expected);
  });

  it("defaults to light when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    expect(() => new Function(themeInitializationScript)()).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("ThemeToggle", () => {
  it("switches both ways, persists the choice and updates native colors", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole("button", { name: "切换为深色模式" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("fitgrid-theme")).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", "#0B0F14");
    await user.click(screen.getByRole("button", { name: "切换为浅色模式" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("fitgrid-theme")).toBe("light");
  });

  it("uses the restored DOM theme and provides stable server markup", () => {
    applyTheme("dark");
    expect(renderToString(<ThemeToggle />)).toContain("切换为深色模式");
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "切换为浅色模式" })).toBeInTheDocument();
  });

  it("still switches and remembers across remounts when storage writes fail", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "QuotaExceededError"); });
    const user = userEvent.setup();
    const view = render(<ThemeToggle />);
    await user.click(screen.getByRole("button", { name: "切换为深色模式" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    view.unmount();
    render(<ThemeToggle />);
    await user.click(screen.getByRole("button", { name: "切换为浅色模式" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("synchronizes localStorage changes, invalid values and clear from another tab", () => {
    render(<ThemeToggle />);
    for (const [key, value, expected] of [["fitgrid-theme", "dark", "dark"], ["fitgrid-theme", "bad", "light"], ["fitgrid-theme", "dark", "dark"], [null, null, "light"]] as const) {
      act(() => fireEvent(window, new StorageEvent("storage", { key, newValue: value, storageArea: window.localStorage })));
      expect(document.documentElement.dataset.theme).toBe(expected);
      expect(screen.getByRole("button", { name: expected === "dark" ? "切换为浅色模式" : "切换为深色模式" })).toBeInTheDocument();
    }
  });

  it("ignores unrelated and sessionStorage updates", () => {
    applyTheme("light");
    render(<ThemeToggle />);
    act(() => fireEvent(window, new StorageEvent("storage", { key: "other", newValue: "dark" })));
    act(() => fireEvent(window, new StorageEvent("storage", { key: "fitgrid-theme", newValue: "dark", storageArea: window.sessionStorage })));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("supports keyboard activation without changing other form values", async () => {
    const user = userEvent.setup();
    render(<><ThemeToggle /><input aria-label="未保存内容" defaultValue="keep me" /></>);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.keyboard(" ");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(screen.getByLabelText("未保存内容")).toHaveValue("keep me");
  });
});
