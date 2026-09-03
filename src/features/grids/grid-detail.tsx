"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { ClientApiError } from "@/lib/api-client";
import { lockDocumentForModal } from "@/lib/modal-isolation";

import { formatDecimal } from "./decimal-display";
import { deleteGridTrade, getGridTrade, recalculateGridTrade } from "./grid-api";
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

const gridTypeSize: Record<GridItem["gridType"], "small" | "medium" | "large"> = {
  1: "small",
  2: "medium",
  3: "large",
};

const buyColumns = [
  { key: "buyPrice", label: "买入价格", side: "buy" },
  { key: "buyCount", label: "买入数量", side: "buy" },
  { key: "buyAmount", label: "买入金额", side: "buy" },
] as const;

const sellColumns = [
  { key: "sellPrice", label: "卖出价格", side: "sell" },
  { key: "sellCount", label: "卖出数量", side: "sell" },
  { key: "sellAmount", label: "卖出金额", side: "sell" },
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

function visibleDeleteError(error: unknown): VisibleError {
  if (error instanceof ClientApiError) {
    return {
      message: error.message || "删除产品失败，请重试",
      requestId: error.requestId,
    };
  }
  return { message: "删除产品失败，请重试" };
}

function displayName(detail: GridTradeDetail): string {
  return detail.productName || detail.productCode;
}

function DeleteConfirmation({
  detail,
  onConfirm,
  onClose,
}: {
  detail: GridTradeDetail;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<VisibleError | null>(null);
  const deletingRef = useRef(false);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();

  const close = useCallback(() => {
    if (!deletingRef.current) onClose();
  }, [onClose]);

  useEffect(() => {
    inputRef.current?.focus();
    const restoreDocument = layerRef.current
      ? lockDocumentForModal(layerRef.current)
      : () => undefined;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        document.activeElement === dialogRef.current ||
        !dialogRef.current.contains(document.activeElement)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreDocument();
    };
  }, [close]);

  useEffect(() => {
    if (deleting) dialogRef.current?.focus();
  }, [deleting]);

  async function handleConfirm() {
    if (confirmation !== detail.productCode || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onConfirm();
    } catch (error) {
      deletingRef.current = false;
      setDeleting(false);
      setDeleteError(visibleDeleteError(error));
    }
  }

  return (
    <div ref={layerRef} className={styles.deleteLayer}>
      <button
        type="button"
        className={styles.deleteBackdrop}
        aria-label="关闭删除确认弹窗"
        tabIndex={-1}
        onClick={close}
      />
      <div
        ref={dialogRef}
        className={styles.deleteDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId}${deleteError ? ` ${errorId}` : ""}`}
        tabIndex={-1}
      >
        <header className={styles.deleteHeader}>
          <div>
            <span className={styles.deleteEyebrow}>Permanent deletion</span>
            <h2 id={titleId}>永久删除产品</h2>
          </div>
          <button type="button" aria-label="关闭" disabled={deleting} onClick={close}>×</button>
        </header>

        <div className={styles.deleteBody}>
          <p id={descriptionId} className={styles.deleteWarning}>
            此操作不可撤销。产品参数与所有网格计算结果都将永久删除。
          </p>
          <dl className={styles.deleteIdentity}>
            <div><dt>产品名称</dt><dd>{displayName(detail)}</dd></div>
            <div><dt>产品代码</dt><dd><code>{detail.productCode}</code></dd></div>
          </dl>
          <label htmlFor={`${titleId}-confirmation`}>输入产品代码确认</label>
          <input
            ref={inputRef}
            id={`${titleId}-confirmation`}
            value={confirmation}
            autoComplete="off"
            spellCheck={false}
            disabled={deleting}
            onChange={(event) => setConfirmation(event.target.value)}
          />
          {deleteError ? (
            <div id={errorId} className={styles.deleteError} role="alert">
              <span>{deleteError.message}</span>
              {deleteError.requestId ? <small>请求 ID：{deleteError.requestId}</small> : null}
            </div>
          ) : null}
        </div>

        <footer className={styles.deleteControls}>
          <button type="button" disabled={deleting} onClick={close}>取消</button>
          <button
            type="button"
            className={styles.confirmDelete}
            disabled={confirmation !== detail.productCode || deleting}
            aria-busy={deleting}
            onClick={() => void handleConfirm()}
          >
            {deleting ? "正在删除…" : "确认永久删除"}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function GridDetail({ id }: { id: string }) {
  const router = useRouter();
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

  async function handleDelete() {
    await deleteGridTrade(id);
    router.replace("/grids");
  }

  if (loading) return <GridDetailLoading />;

  if (loadError || !detail) {
    const error = loadError ?? { message: "加载产品失败，请重试", retryable: true };
    return (
      <div className={`${styles.detail} ${styles.loadError}`} role="alert">
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
      onDelete={handleDelete}
      recalculating={recalculating}
      actionError={actionError}
    />
  );
}

export function GridDetailLoading() {
  return (
    <div
      className={`${styles.detail} ${styles.pageStatus}`}
      role="status"
      aria-label="正在打开产品…"
    >
      <div className={styles.pageStatusIndicator}>
        <span className={styles.spinner} aria-hidden="true" />
        <span>正在打开产品…</span>
      </div>
    </div>
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const rowTriggerRef = useRef<HTMLButtonElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef(false);
  const restoreDeleteFocusRef = useRef(false);
  const items = detail.calculation.items;
  const selectedIndex = selectedSequence === null
    ? null
    : items.findIndex((item) => item.sequence === selectedSequence);
  const inspectorOpen = selectedIndex !== null && selectedIndex >= 0;
  const modalOpen = inspectorOpen || deleteOpen;
  const transactionColumns = detail.isShort
    ? [...sellColumns, ...buyColumns]
    : [...buyColumns, ...sellColumns];
  const columns = [...transactionColumns, ...resultColumns];
  const closeInspector = useCallback(() => {
    restoreFocusRef.current = true;
    setSelectedSequence(null);
  }, []);
  const closeDelete = useCallback(() => {
    restoreDeleteFocusRef.current = true;
    setDeleteOpen(false);
  }, []);

  useEffect(() => {
    if (!inspectorOpen && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      rowTriggerRef.current?.focus();
    }
  }, [inspectorOpen]);

  useEffect(() => {
    if (!deleteOpen && restoreDeleteFocusRef.current) {
      restoreDeleteFocusRef.current = false;
      deleteTriggerRef.current?.focus();
    }
  }, [deleteOpen]);

  return (
    <section
      className={styles.detail}
      aria-labelledby="grid-detail-title"
      aria-busy={recalculating}
    >
      <div
        className={styles.detailContent}
        role="group"
        aria-label="产品详情内容"
        aria-hidden={modalOpen ? true : undefined}
        inert={modalOpen ? true : undefined}
      >
        <header className={styles.heading}>
        <div className={styles.titleBlock}>
          <Link href="/grids" className={styles.backLink}>网格产品 / {detail.productCode}</Link>
          <h1 id="grid-detail-title">{displayName(detail)}</h1>
          <div className={styles.identityLine}>
            <code>{detail.productCode}</code>
            <span className={detail.isShort ? styles.short : styles.long}>
              {detail.isShort ? "做空" : "做多"}
            </span>
          </div>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            disabled={recalculating}
            aria-busy={recalculating}
            onClick={() => void onRecalculate()}
          >
            {recalculating ? "正在计算…" : "重新计算"}
          </button>
          <Link href={`/grids/${detail.id}/edit`}>编辑产品</Link>
          <button
            ref={deleteTriggerRef}
            className={styles.deleteAction}
            type="button"
            onClick={() => setDeleteOpen(true)}
          >
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

        {recalculating ? (
          <div className={styles.recalculateOverlay} role="status" aria-label="正在计算…">
            <div className={styles.recalculateIndicator}>
              <span className={styles.spinner} aria-hidden="true" />
              <span>正在计算…</span>
            </div>
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
              {columns.map((column) => (
                <th
                  scope="col"
                  key={column.key}
                  data-trade-side={"side" in column ? column.side : undefined}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => {
              const selected = index === selectedIndex;
              return (
                <tr
                  key={`${item.sequence}-${item.gridType}`}
                  className={selected ? styles.selectedRow : undefined}
                  data-grid-size={gridTypeSize[item.gridType]}
                  onClick={(event) => {
                    rowTriggerRef.current = event.currentTarget.querySelector("button");
                    setSelectedSequence(item.sequence);
                  }}
                >
                  <td>
                    <button
                      type="button"
                      className={styles.rowButton}
                      aria-label={`查看第 ${item.sequence} 笔明细`}
                      aria-pressed={selected}
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
                    <td
                      key={column.key}
                      data-trade-side={"side" in column ? column.side : undefined}
                    >
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
              {detail.isShort ? (
                <>
                  <td colSpan={3}>总盈利 <strong>{formatDecimal(detail.calculation.totalProfitAmount)}</strong></td>
                  <td colSpan={3} data-trade-side="buy">买入总金额 <strong>{formatDecimal(detail.calculation.totalBuyAmount)}</strong></td>
                </>
              ) : (
                <>
                  <td colSpan={3} data-trade-side="buy">买入总金额 <strong>{formatDecimal(detail.calculation.totalBuyAmount)}</strong></td>
                  <td colSpan={3}>总盈利 <strong>{formatDecimal(detail.calculation.totalProfitAmount)}</strong></td>
                </>
              )}
              <td colSpan={4}>总盈利率 <strong>{formatDecimal(detail.calculation.totalProfitRate)}%</strong></td>
            </tr>
          </tfoot>
          </table>
        </div>
      </div>

      {inspectorOpen ? (
        <GridRowInspector
          items={items}
          selectedIndex={selectedIndex}
          isShort={detail.isShort}
          onSelect={(index) => setSelectedSequence(items[index]?.sequence ?? null)}
          onClose={closeInspector}
        />
      ) : null}


      {deleteOpen ? (
        <DeleteConfirmation detail={detail} onConfirm={onDelete} onClose={closeDelete} />
      ) : null}
    </section>
  );
}
