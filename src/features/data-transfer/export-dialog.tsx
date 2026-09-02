"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { ClientApiError } from "@/lib/api-client";
import { lockDocumentForModal } from "@/lib/modal-isolation";

import { downloadExport } from "./data-transfer-api";
import type { ExportDownload } from "./types";
import styles from "./export-dialog.module.css";

type ExportFormat = "android" | "web";

type ExportDialogProps = {
  open: boolean;
  onClose: () => void;
  download?: (format: ExportFormat) => Promise<ExportDownload>;
};

type VisibleError = {
  message: string;
  requestId?: string;
};

function publicError(error: unknown): VisibleError {
  if (error instanceof ClientApiError) {
    return { message: error.message, requestId: error.requestId };
  }
  return { message: "备份下载失败，请重试" };
}

export function ExportDialog({
  open,
  onClose,
  download = downloadExport,
}: ExportDialogProps) {
  const [busyFormat, setBusyFormat] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<VisibleError | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const downloadLock = useRef(false);
  const onCloseRef = useRef(onClose);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const close = useCallback(() => {
    if (downloadLock.current) return;
    setError(null);
    onCloseRef.current();
  }, []);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeRef.current?.focus();
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
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
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
      previousFocus.current?.focus();
      previousFocus.current = null;
    };
  }, [close, open]);

  useEffect(() => {
    if (open && busyFormat) dialogRef.current?.focus();
  }, [busyFormat, open]);

  async function startDownload(format: ExportFormat) {
    if (downloadLock.current) return;
    downloadLock.current = true;
    setBusyFormat(format);
    setError(null);
    let anchor: HTMLAnchorElement | null = null;
    let objectUrl: string | null = null;

    try {
      const { blob, filename } = await download(format);
      objectUrl = URL.createObjectURL(blob);
      anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
    } catch (caught) {
      setError(publicError(caught));
    } finally {
      try {
        anchor?.remove();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      } finally {
        downloadLock.current = false;
        setBusyFormat(null);
      }
    }
  }

  if (!open) return null;

  const busy = busyFormat !== null;

  return (
    <div ref={layerRef} className={styles.layer}>
      <button
        type="button"
        className={styles.backdrop}
        aria-label="关闭数据备份对话框"
        disabled={busy}
        tabIndex={-1}
        onClick={close}
      />
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Account export</span>
            <h2 id={titleId}>数据备份</h2>
          </div>
          <button ref={closeRef} type="button" disabled={busy} onClick={close}>
            关闭数据备份
          </button>
        </header>

        <p id={descriptionId} className={styles.intro}>
          两种备份都只包含当前账号的数据。请选择与后续用途匹配的格式。
        </p>
        <ul className={styles.formats} aria-label="备份格式">
          <li className={styles.formatRow}>
            <div>
              <h3>Android 兼容 JSON</h3>
              <p>用于重新导入安卓端或迁移到兼容应用。</p>
            </div>
            <button
              type="button"
              disabled={busy}
              aria-busy={busyFormat === "android"}
              onClick={() => void startDownload("android")}
            >
              {busyFormat === "android" ? "正在准备备份…" : "下载 Android 兼容 JSON"}
            </button>
          </li>
          <li className={styles.formatRow}>
            <div>
              <h3>Web 完整备份</h3>
              <p>用于服务器迁移和恢复，并保留稳定元数据。</p>
            </div>
            <button
              type="button"
              disabled={busy}
              aria-busy={busyFormat === "web"}
              onClick={() => void startDownload("web")}
            >
              {busyFormat === "web" ? "正在准备备份…" : "下载 Web 完整备份"}
            </button>
          </li>
        </ul>

        {busyFormat ? (
          <div className={styles.feedback} role="status" aria-live="polite">
            <span className={styles.spinner} aria-hidden="true" />
            <span>
              正在准备{busyFormat === "web" ? " Web 完整备份" : " Android 兼容 JSON"}…
            </span>
          </div>
        ) : null}
        {error ? (
          <div className={styles.error} role="alert">
            <p>{error.message}</p>
            {error.requestId ? <small>请求 ID：{error.requestId}</small> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
