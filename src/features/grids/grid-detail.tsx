"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { ClientApiError } from "@/lib/api-client";

import { formatDecimal } from "./decimal-display";
import { getGridTrade, recalculateGridTrade } from "./grid-api";
import { GridRowInspector } from "./grid-row-inspector";
import type { GridItem, GridTradeDetail } from "./types";
import styles from "./grid-detail.module.css";

type VisibleError = {
  message: string;
  requestId?: string;
  retryable?: boolean;
};

type GridDetailViewProps = {
  detail: GridTradeDetail;
  onRecalculate: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  recalculating?: boolean;
  actionError?: VisibleError | null;
};

const gridTypeLabel: Record<GridItem["gridType"], string> = {
  1: "小网",
  2: "中网",
  3: "大网",
};

const buyColumns = [
  { key: "buyPrice", label: "买入价格" },
  { key: "buyCount", label: "买入数量" },
  { key: "buyAmount", label: "买入金额" },
] as const;

const sellColumns = [
  { key: "sellPrice", label: "卖出价格" },
  { key: "sellCount", label: "卖出数量" },
  { key: "sellAmount", label: "卖出金额" },
] as const;

const resultColumns = [
  { key: "profitAmount", label: "盈利金额" },
  { key: "profitRate", label: "盈利比例", suffix: "%" },
  { key: "keepProfit", label: "本期留存利润" },
  { key: "keepCount", label: "本期留存数量" },
] as const;

function visibleError(error: unknown, fallback: string): VisibleError {
  if (error instanceof ClientApiError) {
    return {
      message: error.status === 404 ? "网格产品不存在" : error.message || fallback,
      requestId: error.requestId,
      retryable: error.status !== 404,
    };
  }
  return { message: fallback, retryable: true };
}

function displayName(detail: GridTradeDetail): string {
  return detail.productName || detail.productCode;
}

export function GridDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<GridTradeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<VisibleError | null>(null);
  const [actionError, setActionError] = useState<VisibleError | null>(null);
  const [recalculating, setRecalculating] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const recalculatingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void getGridTrade(id, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setDetail(loaded);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setDetail(null);
          setLoadError(visibleError(error, "加载产品失败，请重试"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, reloadKey]);

  function reload() {
    setLoading(true);
    setLoadError(null);
    setReloadKey((value) => value + 1);
  }

  async function handleRecalculate() {
    if (recalculatingRef.current) return;
    recalculatingRef.current = true;
    setRecalculating(true);
    setActionError(null);
    try {
      setDetail(await recalculateGridTrade(id));
    } catch (error) {
      setActionError(visibleError(error, "重新计算失败，请重试"));
    } finally {
      recalculatingRef.current = false;
      setRecalculating(false);
    }
  }

  if (loading) {
    return <div className={styles.pageStatus} role="status">正在加载产品…</div>;
  }

  if (loadError || !detail) {
    const error = loadError ?? { message: "加载产品失败，请重试", retryable: true };
    return (
      <div className={styles.loadError} role="alert">
        <div>
          <strong>{error.message}</strong>
          {error.requestId ? <small>请求 ID：{error.requestId}</small> : null}
        </div>
        {error.retryable ? <button type="button" onClick={reload}>重试</button> : null}
      </div>
    );
  }

  return (
    <GridDetailView
      detail={detail}
      onRecalculate={handleRecalculate}
      onDelete={() => undefined}
      recalculating={recalculating}
      actionError={actionError}
    />
  );
}

export function GridDetailView({
  detail,
  onRecalculate,
  onDelete,
  recalculating = false,
  actionError = null,
}: GridDetailViewProps) {
  const [selectedSequence, setSelectedSequence] = useState<number | null>(null);
  const items = detail.calculation.items;
  const selectedIndex = selectedSequence === null
    ? null
    : items.findIndex((item) => item.sequence === selectedSequence);
  const transactionColumns = detail.isShort
    ? [...sellColumns, ...buyColumns]
    : [...buyColumns, ...sellColumns];
  const columns = [...transactionColumns, ...resultColumns];
  const closeInspector = useCallback(() => setSelectedSequence(null), []);

  return (
    <section className={styles.detail} aria-labelledby="grid-detail-title">
      <header className={styles.heading}>
        <div className={styles.titleBlock}>
          <Link href="/grids" className={styles.backLink}>网格产品 / {detail.productCode}</Link>
          <h1 id="grid-detail-title">{displayName(detail)}</h1>
          <div className={styles.identityLine}>
            <code>{detail.productCode}</code>
            <span className={detail.isShort ? styles.short : styles.long}>
              {detail.isShort ? "做空" : "做多"}
            </span>
            <span>算法 {detail.algorithmVersion}</span>
          </div>
        </div>
        <div className={styles.actions}>
          <button type="button" disabled={recalculating} onClick={() => void onRecalculate()}>
            {recalculating ? "正在计算…" : "重新计算"}
          </button>
          <Link href={`/grids/${detail.id}/edit`}>编辑产品</Link>
          <button className={styles.deleteAction} type="button" onClick={() => void onDelete()}>
            删除产品
          </button>
        </div>
      </header>

      <dl className={styles.instrumentStrip} aria-label="产品参数摘要">
        <div>
          <dt>最高价格</dt>
          <dd>{formatDecimal(detail.maxPrice)}</dd>
        </div>
        <div>
          <dt>每份金额</dt>
          <dd>{formatDecimal(detail.perShare)}</dd>
        </div>
        <div>
          <dt>档位幅度</dt>
          <dd>{formatDecimal(detail.input.gearAmplitude)}%</dd>
        </div>
        <div>
          <dt>最大振幅</dt>
          <dd>{detail.input.maxAmplitude}%</dd>
        </div>
      </dl>

      {actionError ? (
        <div className={styles.actionError} role="alert">
          <span>{actionError.message}</span>
          {actionError.requestId ? <small>请求 ID：{actionError.requestId}</small> : null}
        </div>
      ) : null}

      <div className={styles.tableRegion} role="region" aria-label="网格计算结果" tabIndex={0}>
        <table className={styles.financialTable}>
          <caption className={styles.srOnly}>产品 {displayName(detail)} 的网格计算结果</caption>
          <thead>
            <tr>
              <th scope="col">序号</th>
              <th scope="col">种类</th>
              <th scope="col">档位</th>
              {columns.map((column) => <th scope="col" key={column.key}>{column.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => {
              const selected = index === selectedIndex;
              return (
                <tr key={`${item.sequence}-${item.gridType}`} className={selected ? styles.selectedRow : undefined}>
                  <td>
                    <button
                      type="button"
                      className={styles.rowButton}
                      aria-label={`查看第 ${item.sequence} 笔明细`}
                      aria-pressed={selected}
                      onClick={() => setSelectedSequence(item.sequence)}
                    >
                      {item.sequence}
                    </button>
                  </td>
                  <td>
                    <span className={`${styles.gridType} ${styles[`gridType${item.gridType}`]}`}>
                      {gridTypeLabel[item.gridType]}
                    </span>
                  </td>
                  <td>{formatDecimal(item.gear)}%</td>
                  {columns.map((column) => (
                    <td key={column.key}>
                      {formatDecimal(item[column.key])}{"suffix" in column ? column.suffix : ""}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr aria-label="计算汇总">
              <th scope="row" colSpan={3}>计算汇总</th>
              <td colSpan={3}>买入总金额 <strong>{formatDecimal(detail.calculation.totalBuyAmount)}</strong></td>
              <td colSpan={3}>总盈利 <strong>{formatDecimal(detail.calculation.totalProfitAmount)}</strong></td>
              <td colSpan={4}>总盈利率 <strong>{formatDecimal(detail.calculation.totalProfitRate)}%</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {selectedIndex !== null && selectedIndex >= 0 ? (
        <GridRowInspector
          items={items}
          selectedIndex={selectedIndex}
          isShort={detail.isShort}
          onSelect={(index) => setSelectedSequence(items[index]?.sequence ?? null)}
          onClose={closeInspector}
        />
      ) : null}
    </section>
  );
}
