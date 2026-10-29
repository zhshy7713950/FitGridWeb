"use client";

import { useSyncExternalStore } from "react";
import { getServerTheme, getTheme, subscribeToTheme, toggleTheme } from "./theme";
import styles from "./theme-toggle.module.css";

export function ThemeToggle({ floating = false }: { floating?: boolean }) {
  const theme = useSyncExternalStore(subscribeToTheme, getTheme, getServerTheme);
  const label = theme === "light" ? "切换为深色模式" : "切换为浅色模式";

  return (
    <button
      type="button"
      className={`${styles.toggle}${floating ? ` ${styles.floating}` : ""}`}
      aria-label={label}
      title={label}
      onClick={toggleTheme}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {theme === "light" ? (
          <path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z" />
        ) : (
          <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5" /></>
        )}
      </svg>
      <span>{theme === "light" ? "深色模式" : "浅色模式"}</span>
    </button>
  );
}
