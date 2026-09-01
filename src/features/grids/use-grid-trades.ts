"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ClientApiError } from "@/lib/api-client";

import { listGridTrades } from "./grid-api";
import type { GridTradePage, GridTradeSummary } from "./types";

export interface GridTradeListController {
  query: string;
  setQuery(value: string): void;
  clearQuery(): void;
  items: GridTradeSummary[];
  nextCursor: string | null;
  initialLoading: boolean;
  refreshing: boolean;
  pageLoading: boolean;
  initialError: string;
  pageError: string;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  retryPage(): Promise<void>;
}

export type ListGridTrades = (input?: {
  q?: string;
  cursor?: string;
  signal?: AbortSignal;
}) => Promise<GridTradePage>;

function publicMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.name === "AbortError") return "";
  if (error instanceof TypeError) return "网络连接失败，请重试";

  return error instanceof ClientApiError && error.requestId
    ? `${fallback}，请求 ID：${error.requestId}`
    : fallback;
}

export function useGridTrades(
  { request = listGridTrades }: { request?: ListGridTrades } = {},
): GridTradeListController {
  const [query, setQuery] = useState("");
  const [effectiveQuery, setEffectiveQuery] = useState("");
  const [clearVersion, setClearVersion] = useState(0);
  const [items, setItems] = useState<GridTradeSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pageLoading, setPageLoading] = useState(false);
  const [initialError, setInitialError] = useState("");
  const [pageError, setPageError] = useState("");
  const requestVersion = useRef(0);
  const mounted = useRef(false);
  const cursorControllers = useRef(new Map<string, AbortController>());
  const failedCursor = useRef<string | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const effectiveQueryRef = useRef("");
  const refreshInFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const lifetimeRequestVersion = requestVersion;
    const lifetimeCursorControllers = cursorControllers.current;
    mounted.current = true;

    return () => {
      mounted.current = false;
      ++lifetimeRequestVersion.current;
      abortController.current?.abort();
      abortController.current = null;
      for (const controller of lifetimeCursorControllers.values()) controller.abort();
      lifetimeCursorControllers.clear();
      failedCursor.current = null;
      refreshInFlight.current = null;
    };
  }, []);

  const prepareFresh = useCallback((preserveCurrent: boolean) => {
    ++requestVersion.current;
    abortController.current?.abort();
    setInitialLoading(true);
    setPageLoading(false);
    setInitialError("");
    setPageError("");
    setNextCursor(null);
    if (!preserveCurrent) {
      refreshInFlight.current = null;
      setRefreshing(false);
      setItems([]);
    }
    failedCursor.current = null;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextQuery = query.trim();
      if (nextQuery === effectiveQueryRef.current) return;
      prepareFresh(false);
      effectiveQueryRef.current = nextQuery;
      setEffectiveQuery(nextQuery);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [prepareFresh, query]);

  const performFresh = useCallback(async (q: string) => {
    const version = ++requestVersion.current;
    abortController.current?.abort();
    const controller = new AbortController();
    abortController.current = controller;

    try {
      const page = await request({ q: q || undefined, signal: controller.signal });
      if (!mounted.current || version !== requestVersion.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (mounted.current && version === requestVersion.current) {
        setInitialError(publicMessage(error, "加载产品失败"));
      }
    } finally {
      if (abortController.current === controller) abortController.current = null;
      if (mounted.current && version === requestVersion.current) setInitialLoading(false);
    }
  }, [request]);

  useEffect(() => {
    const version = ++requestVersion.current;
    abortController.current?.abort();
    const controller = new AbortController();
    abortController.current = controller;
    let active = true;

    void request({ q: effectiveQuery || undefined, signal: controller.signal })
      .then(
        (page) => {
          if (!active || !mounted.current || version !== requestVersion.current) return;
          setItems(page.items);
          setNextCursor(page.nextCursor);
        },
        (error: unknown) => {
          if (!active || !mounted.current || version !== requestVersion.current) return;
          setInitialError(publicMessage(error, "加载产品失败"));
        },
      )
      .finally(() => {
        if (abortController.current === controller) abortController.current = null;
        if (active && mounted.current && version === requestVersion.current) {
          setInitialLoading(false);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [clearVersion, effectiveQuery, request]);

  const loadCursor = useCallback(async (cursor: string) => {
    if (!mounted.current || cursorControllers.current.has(cursor)) return;

    const version = requestVersion.current;
    const controller = new AbortController();
    cursorControllers.current.set(cursor, controller);
    setPageLoading(true);
    setPageError("");

    try {
      const page = await request({
        q: effectiveQuery || undefined,
        cursor,
        signal: controller.signal,
      });
      if (!mounted.current || version !== requestVersion.current) return;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      failedCursor.current = null;
    } catch (error) {
      if (mounted.current && version === requestVersion.current) {
        failedCursor.current = cursor;
        setPageError(publicMessage(error, "加载更多失败"));
      }
    } finally {
      if (cursorControllers.current.get(cursor) === controller) {
        cursorControllers.current.delete(cursor);
      }
      if (mounted.current && version === requestVersion.current) {
        setPageLoading(false);
      }
    }
  }, [effectiveQuery, request]);

  const refresh = useCallback(() => {
    if (!mounted.current) return Promise.resolve();
    if (refreshInFlight.current) return refreshInFlight.current;

    prepareFresh(true);
    setRefreshing(true);
    const pending = performFresh(effectiveQueryRef.current);
    refreshInFlight.current = pending;
    void pending.finally(() => {
      if (refreshInFlight.current !== pending) return;
      refreshInFlight.current = null;
      if (mounted.current) setRefreshing(false);
    });
    return pending;
  }, [performFresh, prepareFresh]);

  return {
    query,
    setQuery,
    clearQuery: () => {
      prepareFresh(false);
      effectiveQueryRef.current = "";
      setQuery("");
      setEffectiveQuery("");
      setClearVersion((current) => current + 1);
    },
    items,
    nextCursor,
    initialLoading,
    refreshing,
    pageLoading,
    initialError,
    pageError,
    refresh,
    loadMore: () => nextCursor ? loadCursor(nextCursor) : Promise.resolve(),
    retryPage: () => failedCursor.current ? loadCursor(failedCursor.current) : Promise.resolve(),
  };
}
