"use client";

import { useEffect, useRef } from "react";

import { lockDocumentForModal } from "@/lib/modal-isolation";

import { formatDecimal } from "./decimal-display";
import type { GridItem } from "./types";
import styles from "./grid-detail.module.css";

const gridTypeLabel: Record<GridItem["gridType"], string> = {
  1: "小网",
  2: "中网",
  3: "大网",
};

type GridRowInspectorProps = {
  items: GridItem[];
  selectedIndex: number;
  isShort: boolean;
  onSelect: (index: number) => void;
  onClose: () => void;
};

export function GridRowInspector({
  items,
  selectedIndex,
  isShort,
  onSelect,
  onClose,
}: GridRowInspectorProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const item = items[selectedIndex];

  useEffect(() => {
    closeButton.current?.focus();
    const restoreDocument = layer.current
      ? lockDocumentForModal(layer.current)
      : () => undefined;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled):not([aria-hidden='true']), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      ) ?? []);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      restoreDocument();
    };
  }, [onClose]);

  if (!item) return null;

  const buyFields = [
    { label: "买入价格", value: item.buyPrice },
    { label: "买入数量", value: item.buyCount },
  ];
  const sellFields = [
    { label: "卖出价格", value: item.sellPrice },
    { label: "卖出数量", value: item.sellCount },
  ];
  const fields = isShort ? [...sellFields, ...buyFields] : [...buyFields, ...sellFields];

  return (
    <div ref={layer} className={styles.inspectorLayer}>
      <button
        className={styles.inspectorBackdrop}
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        ref={dialog}
        className={styles.inspector}
        role="dialog"
        aria-modal="true"
        aria-labelledby="grid-row-inspector-title"
      >
        <header className={styles.inspectorHeader}>
          <div>
            <span className={styles.eyebrow}>Calculation item</span>
            <h2 id="grid-row-inspector-title">网格行明细</h2>
          </div>
          <button ref={closeButton} type="button" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className={styles.inspectorIndex}>
          <span className={`${styles.gridType} ${styles[`gridType${item.gridType}`]}`}>
            {gridTypeLabel[item.gridType]}
          </span>
          <strong>{selectedIndex + 1} / {items.length}</strong>
        </div>

        <dl className={styles.inspectorValues}>
          {fields.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>{formatDecimal(field.value)}</dd>
            </div>
          ))}
        </dl>

        <footer className={styles.inspectorControls}>
          <button
            type="button"
            disabled={selectedIndex === 0}
            onClick={() => onSelect(selectedIndex - 1)}
          >
            上一笔
          </button>
          <button
            type="button"
            disabled={selectedIndex === items.length - 1}
            onClick={() => onSelect(selectedIndex + 1)}
          >
            下一笔
          </button>
        </footer>
      </aside>
    </div>
  );
}
