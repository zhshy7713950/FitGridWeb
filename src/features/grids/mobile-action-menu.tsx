"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import styles from "./mobile-action-menu.module.css";

export function MobileActionMenu({
  children,
  label,
  triggerRef: externalTriggerRef,
}: {
  children: ReactNode;
  label: string;
  triggerRef?: { current: HTMLButtonElement | null };
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const setTriggerRef = useCallback((node: HTMLButtonElement | null) => {
    triggerRef.current = node;
    if (externalTriggerRef) externalTriggerRef.current = node;
  }, [externalTriggerRef]);

  useEffect(() => {
    if (!open) return;

    panelRef.current
      ?.querySelector<HTMLElement>("button:not(:disabled), a[href]")
      ?.focus();

    function closeFromOutside(event: PointerEvent | FocusEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }

    function closeFromEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("focusin", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("focusin", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={styles.menu}>
      <button
        ref={setTriggerRef}
        type="button"
        className={styles.trigger}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="5" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="12" cy="19" r="1.7" />
        </svg>
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={menuId}
          className={styles.panel}
          role="group"
          aria-label={`${label}菜单`}
          onClick={(event) => {
            if (!(event.target instanceof Element) || !event.target.closest("button, a")) return;
            triggerRef.current?.focus();
            setOpen(false);
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
