"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ClientApiError } from "@/lib/api-client";

import { listUsers, updateUserStatus } from "./admin-api";
import type { ListUsersInput } from "./admin-api";
import type { ManagedUser, ManagedUserPage } from "./types";

const pageLimit = 20;

export type ListManagedUsers = (input?: ListUsersInput) => Promise<ManagedUserPage>;
export type UpdateManagedUserStatus = (
  userId: string,
  status: ManagedUser["status"],
  signal?: AbortSignal,
) => Promise<ManagedUser>;

export interface AdminListError {
  message: string;
  status?: number;
  code?: string;
  requestId?: string;
  retryAfterSeconds?: number;
}

export interface AdminUserListController {
  items: ManagedUser[];
  nextCursor: string | null;
  initialLoading: boolean;
  pageLoading: boolean;
  initialError: AdminListError | null;
  pageError: AdminListError | null;
  retryInitial(): Promise<void>;
  loadMore(): Promise<void>;
  retryPage(): Promise<void>;
  updateStatus(
    userId: string,
    status: ManagedUser["status"],
    signal?: AbortSignal,
  ): Promise<ManagedUser>;
}

function publicListError(error: unknown, fallback: string): AdminListError | null {
  if (error instanceof Error && error.name === "AbortError") return null;
  if (error instanceof ClientApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      requestId: error.requestId,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  if (error instanceof TypeError) return { message: "网络连接失败，请重试" };
  return { message: fallback };
}

export function useAdminUsers({
  list = listUsers,
  update = updateUserStatus,
}: {
  list?: ListManagedUsers;
  update?: UpdateManagedUserStatus;
} = {}): AdminUserListController {
  const [items, setItems] = useState<ManagedUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [initialError, setInitialError] = useState<AdminListError | null>(null);
  const [pageError, setPageError] = useState<AdminListError | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const initialController = useRef<AbortController | null>(null);
  const cursorRequests = useRef(new Map<string, Promise<void>>());
  const cursorControllers = useRef(new Map<string, AbortController>());
  const failedCursor = useRef<string | null>(null);
  const initialRetryUntil = useRef(0);
  const pageRetryUntil = useRef(0);
  const listRef = useRef(list);
  const updateRef = useRef(update);

  useEffect(() => {
    listRef.current = list;
  }, [list]);

  useEffect(() => {
    updateRef.current = update;
  }, [update]);

  const loadInitial = useCallback(async () => {
    if (Date.now() < initialRetryUntil.current) return;
    const requestGeneration = ++generation.current;
    initialController.current?.abort();
    for (const controller of cursorControllers.current.values()) controller.abort();
    cursorControllers.current.clear();
    cursorRequests.current.clear();
    failedCursor.current = null;
    const controller = new AbortController();
    initialController.current = controller;
    setInitialLoading(true);
    initialRetryUntil.current = 0;
    pageRetryUntil.current = 0;
    setInitialError(null);
    setPageError(null);
    setNextCursor(null);

    try {
      const page = await listRef.current({ limit: pageLimit, signal: controller.signal });
      if (!mounted.current || requestGeneration !== generation.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (!mounted.current || requestGeneration !== generation.current) return;
      const publicError = publicListError(error, "加载账号失败");
      if (publicError?.retryAfterSeconds) {
        initialRetryUntil.current = Date.now() + publicError.retryAfterSeconds * 1_000;
      }
      setInitialError(publicError);
    } finally {
      if (initialController.current === controller) initialController.current = null;
      if (mounted.current && requestGeneration === generation.current) setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const lifetimeGeneration = generation;
    const ownedCursorControllers = cursorControllers.current;
    const ownedCursorRequests = cursorRequests.current;
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    initialController.current = controller;

    void listRef.current({ limit: pageLimit, signal: controller.signal })
      .then(
        (page) => {
          if (!mounted.current || requestGeneration !== generation.current) return;
          setItems(page.items);
          setNextCursor(page.nextCursor);
        },
        (error: unknown) => {
          if (!mounted.current || requestGeneration !== generation.current) return;
          const publicError = publicListError(error, "加载账号失败");
          if (publicError?.retryAfterSeconds) {
            initialRetryUntil.current = Date.now() + publicError.retryAfterSeconds * 1_000;
          }
          setInitialError(publicError);
        },
      )
      .finally(() => {
        if (initialController.current === controller) initialController.current = null;
        if (mounted.current && requestGeneration === generation.current) setInitialLoading(false);
      });

    return () => {
      mounted.current = false;
      ++lifetimeGeneration.current;
      initialController.current?.abort();
      initialController.current = null;
      for (const controller of ownedCursorControllers.values()) controller.abort();
      ownedCursorControllers.clear();
      ownedCursorRequests.clear();
      failedCursor.current = null;
      initialRetryUntil.current = 0;
      pageRetryUntil.current = 0;
    };
  }, [loadInitial]);

  const hasRetryCountdown =
    (initialError?.retryAfterSeconds ?? 0) > 0 || (pageError?.retryAfterSeconds ?? 0) > 0;

  useEffect(() => {
    if (!hasRetryCountdown) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setInitialError((current) => {
        if (!current?.retryAfterSeconds) return current;
        const remaining = Math.max(0, Math.ceil((initialRetryUntil.current - now) / 1_000));
        return remaining === current.retryAfterSeconds
          ? current
          : { ...current, retryAfterSeconds: remaining || undefined };
      });
      setPageError((current) => {
        if (!current?.retryAfterSeconds) return current;
        const remaining = Math.max(0, Math.ceil((pageRetryUntil.current - now) / 1_000));
        return remaining === current.retryAfterSeconds
          ? current
          : { ...current, retryAfterSeconds: remaining || undefined };
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [hasRetryCountdown]);

  const loadCursor = useCallback((cursor: string): Promise<void> => {
    if (Date.now() < pageRetryUntil.current) return Promise.resolve();
    const existing = cursorRequests.current.get(cursor);
    if (existing) return existing;
    if (!mounted.current) return Promise.resolve();

    const requestGeneration = generation.current;
    const controller = new AbortController();
    cursorControllers.current.set(cursor, controller);
    pageRetryUntil.current = 0;
    setPageLoading(true);
    setPageError(null);

    const pending = listRef.current({ cursor, limit: pageLimit, signal: controller.signal })
      .then((page) => {
        if (!mounted.current || requestGeneration !== generation.current) return;
        setItems((current) => {
          const knownIds = new Set(current.map((user) => user.id));
          const appended = page.items.filter((user) => !knownIds.has(user.id));
          return appended.length ? [...current, ...appended] : current;
        });
        setNextCursor(page.nextCursor);
        failedCursor.current = null;
        pageRetryUntil.current = 0;
      })
      .catch((error: unknown) => {
        if (!mounted.current || requestGeneration !== generation.current) return;
        failedCursor.current = cursor;
        const publicError = publicListError(error, "加载更多账号失败");
        if (publicError?.retryAfterSeconds) {
          pageRetryUntil.current = Date.now() + publicError.retryAfterSeconds * 1_000;
        }
        setPageError(publicError);
      })
      .finally(() => {
        if (cursorControllers.current.get(cursor) === controller) {
          cursorControllers.current.delete(cursor);
        }
        if (cursorRequests.current.get(cursor) === pending) cursorRequests.current.delete(cursor);
        if (mounted.current && requestGeneration === generation.current) setPageLoading(false);
      });

    cursorRequests.current.set(cursor, pending);
    return pending;
  }, []);

  const changeStatus = useCallback(async (
    userId: string,
    status: ManagedUser["status"],
    signal?: AbortSignal,
  ) => {
    const updated = await updateRef.current(userId, status, signal);
    if (mounted.current) {
      setItems((current) => current.map((user) => user.id === userId ? updated : user));
    }
    return updated;
  }, []);

  return {
    items,
    nextCursor,
    initialLoading,
    pageLoading,
    initialError,
    pageError,
    retryInitial: loadInitial,
    loadMore: () => nextCursor ? loadCursor(nextCursor) : Promise.resolve(),
    retryPage: () => failedCursor.current ? loadCursor(failedCursor.current) : Promise.resolve(),
    updateStatus: changeStatus,
  };
}
