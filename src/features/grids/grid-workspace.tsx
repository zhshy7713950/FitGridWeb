"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type UIEvent } from "react";

import { ExportDialog } from "@/features/data-transfer/export-dialog";
import { withBasePath } from "@/lib/app-paths";

import { formatDecimal } from "./decimal-display";
import type { GridTradeSummary } from "./types";
import { useGridTrades, type GridTradeListController } from "./use-grid-trades";
import styles from "./grid-workspace.module.css";

function displayName(item: GridTradeSummary): string {
  return item.productName || item.productCode;
}

const refreshFeedbackDurationMs = 500;

const updatedAtFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Shanghai",
});

function displayUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  const parts = Object.fromEntries(
    updatedAtFormatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function GridWorkspace() {
  const controller = useGridTrades();
  return <GridWorkspaceView controller={controller} />;
}

export function GridWorkspaceView({
  controller,
}: {
  controller: GridTradeListController;
}) {
  const [showRefreshOverlay, setShowRefreshOverlay] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const refreshFeedback = useRef<Promise<void> | null>(null);
  const refreshFeedbackTimer = useRef<number | null>(null);
  const resolveRefreshDelay = useRef<(() => void) | null>(null);
  const mounted = useRef(true);

  const refreshBusy = controller.refreshing || showRefreshOverlay;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (refreshFeedbackTimer.current !== null) {
        window.clearTimeout(refreshFeedbackTimer.current);
        refreshFeedbackTimer.current = null;
      }
      resolveRefreshDelay.current?.();
      resolveRefreshDelay.current = null;
      refreshFeedback.current = null;
    };
  }, []);

  function refreshWithFeedback() {
    if (refreshFeedback.current || controller.refreshing) return;

    setShowRefreshOverlay(true);
    const minimumDisplay = new Promise<void>((resolve) => {
      resolveRefreshDelay.current = resolve;
      refreshFeedbackTimer.current = window.setTimeout(() => {
        refreshFeedbackTimer.current = null;
        resolveRefreshDelay.current = null;
        resolve();
      }, refreshFeedbackDurationMs);
    });
    let refreshRequest: Promise<void>;
    try {
      refreshRequest = controller.refresh();
    } catch (error) {
      refreshRequest = Promise.reject(error);
    }
    const pending = Promise.allSettled([refreshRequest, minimumDisplay]).then(() => {
      if (!mounted.current || refreshFeedback.current !== pending) return;
      refreshFeedback.current = null;
      setShowRefreshOverlay(false);
    });
    refreshFeedback.current = pending;
  }

  function nearBottom(event: UIEvent<HTMLElement>) {
    const target = event.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight <= 240) {
      void controller.loadMore();
    }
  }

  const hasQuery = controller.query.trim().length > 0;
  const emptyText = hasQuery
    ? "没有匹配的产品"
    : "还没有网格产品";

  return (
    <section className={styles.workspace} aria-labelledby="grid-title">
      <header className={styles.heading}>
        <div>
          <span>Grid strategies · 已载入 {controller.items.length} 项</span>
          <h1 id="grid-title">网格产品</h1>
        </div>
        <div className={styles.headingActions}>
          <button
            type="button"
            disabled={refreshBusy}
            aria-disabled={refreshBusy}
            aria-busy={refreshBusy}
            onClick={refreshWithFeedback}
          >
            刷新
          </button>
          <Link href={withBasePath("/grids/import")}>导入数据</Link>
          <button type="button" onClick={() => setExportOpen(true)}>数据备份</button>
          <Link className={styles.primaryAction} href="/grids/new">新建产品</Link>
        </div>
      </header>

      {refreshBusy ? (
        <div className={styles.refreshOverlay} role="status" aria-label="正在刷新…">
          <div className={styles.refreshIndicator}>
            <span className={styles.spinner} aria-hidden="true" />
            <span>正在刷新…</span>
          </div>
        </div>
      ) : null}

      <div className={styles.searchBar}>
        <label htmlFor="grid-search">搜索产品名称或代码</label>
        <input
          id="grid-search"
          type="search"
          value={controller.query}
          onChange={(event) => controller.setQuery(event.target.value)}
        />
        {hasQuery && controller.items.length ? (
          <button type="button" onClick={controller.clearQuery}>
            清除搜索
          </button>
        ) : null}
      </div>

      {controller.initialError && !controller.items.length ? (
        <div className={styles.errorBanner} role="alert">
          <span>{controller.initialError}</span>
          <button type="button" disabled={refreshBusy} onClick={refreshWithFeedback}>
            重试
          </button>
        </div>
      ) : null}

      {controller.initialError && controller.items.length ? (
        <div className={styles.errorBanner} role="alert">
          <span>{controller.initialError}</span>
          <button type="button" disabled={refreshBusy} onClick={refreshWithFeedback}>
            重试刷新
          </button>
        </div>
      ) : null}

      {controller.initialLoading && !controller.items.length ? (
        <div role="status" className={styles.loading}>
          正在加载产品…
        </div>
      ) : null}

      {!controller.initialLoading &&
      !controller.initialError &&
      !controller.items.length ? (
        hasQuery ? (
          <div className={styles.empty} role="region" aria-label="搜索结果空状态">
            <p>{emptyText}</p>
            <div className={styles.emptyActions}>
              <button type="button" onClick={controller.clearQuery}>清除搜索</button>
            </div>
          </div>
        ) : (
          <div className={styles.empty} role="region" aria-label="账号产品空状态">
            <p>{emptyText}</p>
            <div className={styles.emptyActions}>
              <Link className={styles.primaryAction} href="/grids/new">新建产品</Link>
              <Link href={withBasePath("/grids/import")}>导入数据</Link>
              <button type="button" onClick={() => setExportOpen(true)}>数据备份</button>
            </div>
          </div>
        )
      ) : null}

      {controller.items.length ? (
        <div
          className={styles.listViewport}
          role="region"
          aria-label="网格产品列表"
          onScroll={nearBottom}
        >
          <table className={styles.productTable} aria-label="网格产品">
            <caption className={styles.srOnly}>当前账号的网格产品</caption>
            <colgroup>
              <col className={styles.productNameColumn} />
              <col className={styles.productCodeColumn} />
              <col className={styles.desktopOnly} />
              <col className={styles.priceColumn} />
              <col className={styles.shareColumn} />
              <col className={styles.desktopOnly} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">产品名称</th>
                <th scope="col">产品代码</th>
                <th scope="col" className={styles.desktopOnly}>方向</th>
                <th scope="col">最高价</th>
                <th scope="col">每份金额</th>
                <th scope="col" className={styles.desktopOnly}>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {controller.items.map((item) => (
                <tr key={item.id}>
                  <td className={styles.productName}>
                    <Link href={`/grids/${item.id}`}>{displayName(item)}</Link>
                  </td>
                  <td className={styles.numeric}>{item.productCode}</td>
                  <td className={styles.desktopOnly}>
                    <span className={item.isShort ? styles.short : styles.long}>
                      {item.isShort ? "做空" : "做多"}
                    </span>
                  </td>
                  <td className={styles.numeric}>{formatDecimal(item.maxPrice)}</td>
                  <td className={styles.numeric}>{formatDecimal(item.perShare)}</td>
                  <td className={`${styles.numeric} ${styles.desktopOnly}`}>
                    <time dateTime={item.updatedAt}>{displayUpdatedAt(item.updatedAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className={styles.pagination} aria-live="polite">
        {controller.pageError ? (
          <>
            <span>{controller.pageError}</span>
            <button type="button" onClick={() => void controller.retryPage()}>
              重试加载更多
            </button>
          </>
        ) : controller.nextCursor ? (
          <button
            type="button"
            aria-disabled={controller.pageLoading}
            aria-busy={controller.pageLoading}
            onClick={() => {
              if (!controller.pageLoading) void controller.loadMore();
            }}
          >
            {controller.pageLoading ? "正在加载…" : "加载更多"}
          </button>
        ) : null}
      </div>

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </section>
  );
}
