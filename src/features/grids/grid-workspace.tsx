"use client";

import type { UIEvent } from "react";

import { formatDecimal } from "./decimal-display";
import type { GridTradeSummary } from "./types";
import { useGridTrades, type GridTradeListController } from "./use-grid-trades";
import styles from "./grid-workspace.module.css";

function displayName(item: GridTradeSummary): string {
  return item.productName || item.productCode;
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
  function nearBottom(event: UIEvent<HTMLElement>) {
    const target = event.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight <= 240) {
      void controller.loadMore();
    }
  }

  const emptyText = controller.query
    ? "没有匹配的产品"
    : "还没有网格产品";

  return (
    <section className={styles.workspace} aria-labelledby="grid-title">
      <header className={styles.heading}>
        <div>
          <span>Grid strategies · 已载入 {controller.items.length} 项</span>
          <h1 id="grid-title">网格产品</h1>
        </div>
        <button type="button" onClick={() => void controller.refresh()}>
          刷新
        </button>
      </header>

      <div className={styles.searchBar}>
        <label htmlFor="grid-search">搜索产品名称或代码</label>
        <input
          id="grid-search"
          type="search"
          value={controller.query}
          onChange={(event) => controller.setQuery(event.target.value)}
        />
        {controller.query ? (
          <button type="button" onClick={controller.clearQuery}>
            清除搜索
          </button>
        ) : null}
      </div>

      {controller.initialError && !controller.items.length ? (
        <div className={styles.errorBanner} role="alert">
          <span>{controller.initialError}</span>
          <button type="button" onClick={() => void controller.refresh()}>
            重试
          </button>
        </div>
      ) : null}

      {controller.initialError && controller.items.length ? (
        <div className={styles.errorBanner} role="alert">
          <span>{controller.initialError}</span>
          <button type="button" onClick={() => void controller.refresh()}>
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
        <div className={styles.empty}>{emptyText}</div>
      ) : null}

      {controller.items.length ? (
        <div
          className={styles.listViewport}
          role="region"
          aria-label="网格产品列表"
          onScroll={nearBottom}
        >
          <table className={styles.desktopTable} aria-label="网格产品">
            <caption className={styles.srOnly}>当前账号的网格产品</caption>
            <thead>
              <tr>
                <th scope="col">产品名称</th>
                <th scope="col">产品代码</th>
                <th scope="col">最高价</th>
                <th scope="col">每份金额</th>
              </tr>
            </thead>
            <tbody>
              {controller.items.map((item) => (
                <tr key={item.id}>
                  <td>{displayName(item)}</td>
                  <td className={styles.numeric}>{item.productCode}</td>
                  <td className={styles.numeric}>{formatDecimal(item.maxPrice)}</td>
                  <td className={styles.numeric}>{formatDecimal(item.perShare)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className={styles.mobileCards} aria-label="网格产品卡片">
            {controller.items.map((item) => (
              <li key={item.id}>
                <h2>{displayName(item)}</h2>
                <dl>
                  <div>
                    <dt>产品代码</dt>
                    <dd>{item.productCode}</dd>
                  </div>
                  <div>
                    <dt>最高价</dt>
                    <dd>{formatDecimal(item.maxPrice)}</dd>
                  </div>
                  <div>
                    <dt>每份金额</dt>
                    <dd>{formatDecimal(item.perShare)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
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
    </section>
  );
}
