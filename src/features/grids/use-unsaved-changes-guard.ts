"use client";

import { useEffect, useRef, useState } from "react";

const confirmationMessage = "尚有未保存的修改，确定离开吗？";
const historyMarker = "__fitgridUnsavedChangesGuard";

type GuardHistoryState = {
  id: string;
  role: "sentinel" | "buffer";
  originalState: unknown;
};

let nextGuardId = 0;

function readGuardState(state: unknown): GuardHistoryState | null {
  if (!state || typeof state !== "object") return null;
  const marker = (state as Record<string, unknown>)[historyMarker];
  if (!marker || typeof marker !== "object") return null;
  const candidate = marker as Partial<GuardHistoryState>;
  if (
    typeof candidate.id !== "string" ||
    (candidate.role !== "sentinel" && candidate.role !== "buffer")
  ) {
    return null;
  }
  return candidate as GuardHistoryState;
}

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
  const retireTimer = useRef<number | null>(null);
  const [guardId] = useState(() => `grid-form-${++nextGuardId}`);

  useEffect(() => {
    if (!dirty) return;

    if (retireTimer.current !== null) {
      window.clearTimeout(retireTimer.current);
      retireTimer.current = null;
    }

    const nativePushState = window.history.pushState.bind(window.history);
    const nativeReplaceState = window.history.replaceState.bind(window.history);
    const nativeBack = window.history.back.bind(window.history);
    const nativeForward = window.history.forward.bind(window.history);
    const currentMarker = readGuardState(window.history.state);
    const originalState = currentMarker?.id === guardId
      ? currentMarker.originalState
      : window.history.state;

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
      const marker = readGuardState(window.history.state);
      if (marker?.id !== guardId || marker.role !== "sentinel") return;
      if (window.confirm(confirmationMessage)) {
        ignoreNextPop.current = true;
        nativeBack();
      } else {
        ignoreNextPop.current = true;
        nativeForward();
      }
    };

    if (currentMarker?.id !== guardId || currentMarker.role !== "buffer") {
      const visibleState = originalState && typeof originalState === "object" ? originalState : {};
      nativeReplaceState(
        { ...visibleState, [historyMarker]: { id: guardId, role: "sentinel", originalState } },
        "",
        window.location.href,
      );
      nativePushState(
        { ...visibleState, [historyMarker]: { id: guardId, role: "buffer", originalState } },
        "",
        window.location.href,
      );
    }

    const guardedPushState: History["pushState"] = (data, unused, url) => {
      const marker = readGuardState(window.history.state);
      if (marker?.id === guardId && marker.role === "buffer") {
        nativeReplaceState(data, unused, url);
        return;
      }
      nativePushState(data, unused, url);
    };
    window.history.pushState = guardedPushState;
    window.addEventListener("beforeunload", warnBeforeUnload);
    window.addEventListener("popstate", guardHistory);
    document.addEventListener("click", guardAnchor, true);

    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      window.removeEventListener("popstate", guardHistory);
      document.removeEventListener("click", guardAnchor, true);
      if (window.history.pushState === guardedPushState) {
        window.history.pushState = nativePushState;
      }
      ignoreNextPop.current = false;

      retireTimer.current = window.setTimeout(() => {
        retireTimer.current = null;
        const marker = readGuardState(window.history.state);
        if (marker?.id !== guardId || marker.role !== "buffer") return;
        window.addEventListener("popstate", () => {
          const arrived = readGuardState(window.history.state);
          if (arrived?.id === guardId && arrived.role === "sentinel") {
            nativeReplaceState(arrived.originalState, "", window.location.href);
          }
        }, { once: true });
        nativeBack();
      }, 0);
    };
  }, [dirty, guardId]);
}
