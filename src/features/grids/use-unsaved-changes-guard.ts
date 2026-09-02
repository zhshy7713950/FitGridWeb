"use client";

import { useEffect, useRef } from "react";

const confirmationMessage = "尚有未保存的修改，确定离开吗？";
const historyMarker = "__fitgridUnsavedChangesGuard";

function isInternalPageNavigation(event: MouseEvent): boolean {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return false;
  }

  const target = event.target;
  const anchor = target instanceof Element ? target.closest("a[href]") : null;
  if (!(anchor instanceof HTMLAnchorElement) || anchor.download) return false;
  if (anchor.target && anchor.target !== "_self") return false;

  const destination = new URL(anchor.href, window.location.href);
  if (destination.origin !== window.location.origin) return false;

  return (
    destination.pathname !== window.location.pathname ||
    destination.search !== window.location.search
  );
}

export function useUnsavedChangesGuard(dirty: boolean) {
  const ignoreNextPop = useRef(false);

  useEffect(() => {
    if (!dirty) return;

    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const guardAnchor = (event: MouseEvent) => {
      if (!isInternalPageNavigation(event)) return;
      if (!window.confirm(confirmationMessage)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const guardHistory = () => {
      if (ignoreNextPop.current) {
        ignoreNextPop.current = false;
        return;
      }
      if (window.confirm(confirmationMessage)) {
        ignoreNextPop.current = true;
        window.history.back();
      } else {
        ignoreNextPop.current = true;
        window.history.forward();
      }
    };

    const currentState = window.history.state;
    window.history.pushState(
      {
        ...(currentState && typeof currentState === "object" ? currentState : {}),
        [historyMarker]: true,
      },
      "",
      window.location.href,
    );
    window.addEventListener("beforeunload", warnBeforeUnload);
    window.addEventListener("popstate", guardHistory);
    document.addEventListener("click", guardAnchor, true);

    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      window.removeEventListener("popstate", guardHistory);
      document.removeEventListener("click", guardAnchor, true);
      ignoreNextPop.current = false;
    };
  }, [dirty]);
}
