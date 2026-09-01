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
  const [pageLoading, setPageLoading] = useState(false);
  const [initialError, setInitialError] = useState("");
  const [pageError, setPageError] = useState("");
  const requestVersion = useRef(0);
  const pageInFlight = useRef<string | null>(null);
  const failedCursor = useRef<string | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const effectiveQueryRef = useRef("");

  const prepareFresh = useCallback((preserveCurrent: boolean) => {
    ++requestVersion.current;
    abortController.current?.abort();
    setInitialLoading(true);
    setPageLoading(false);
    setInitialError("");
    setPageError("");
    setNextCursor(null);
    if (!preserveCurrent) setItems([]);
    failedCursor.current = null;
    pageInFlight.current = null;
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
      if (version !== requestVersion.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (version === requestVersion.current) {
        setInitialError(publicMessage(error, "加载产品失败"));
      }
    } finally {
      if (version === requestVersion.current) setInitialLoading(false);
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
          if (!active || version !== requestVersion.current) return;
          setItems(page.items);
          setNextCursor(page.nextCursor);
        },
        (error: unknown) => {
          if (!active || version !== requestVersion.current) return;
          setInitialError(publicMessage(error, "加载产品失败"));
        },
      )
      .finally(() => {
        if (active && version === requestVersion.current) setInitialLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [clearVersion, effectiveQuery, request]);

  const loadCursor = useCallback(async (cursor: string) => {
    if (pageInFlight.current === cursor) return;

    const version = requestVersion.current;
    pageInFlight.current = cursor;
    setPageLoading(true);
    setPageError("");

    try {
      const page = await request({ q: effectiveQuery || undefined, cursor });
      if (version !== requestVersion.current) return;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      failedCursor.current = null;
    } catch (error) {
      if (version === requestVersion.current) {
        failedCursor.current = cursor;
        setPageError(publicMessage(error, "加载更多失败"));
      }
    } finally {
      if (version === requestVersion.current) {
        pageInFlight.current = null;
        setPageLoading(false);
      }
    }
  }, [effectiveQuery, request]);

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
    pageLoading,
    initialError,
    pageError,
    refresh: () => {
      prepareFresh(true);
      return performFresh(effectiveQuery);
    },
    loadMore: () => nextCursor ? loadCursor(nextCursor) : Promise.resolve(),
    retryPage: () => failedCursor.current ? loadCursor(failedCursor.current) : Promise.resolve(),
  };
}
