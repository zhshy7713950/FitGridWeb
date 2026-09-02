"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { apiPath } from "@/lib/app-paths";

import { lockDocumentForModal } from "../grids/modal-isolation";
import styles from "./data-transfer.module.css";
import type { ImportConflictPolicy, ImportPreview, ImportPreviewItem, ImportReport } from "./types";
import { type GridImportController, useGridImport } from "./use-grid-import";

type ImportWorkspaceProps = {
  controller?: GridImportController;
};

type PreviewContentProps = {
  filename: string;
  preview: ImportPreview;
  policy: ImportConflictPolicy;
  error?: string | null;
  busy?: boolean;
  onPolicyChange: (policy: ImportConflictPolicy) => void;
  onCommit: () => void;
  onReset: () => void;
  commitTriggerRef?: React.RefObject<HTMLButtonElement | null>;
};

const previewGroups: Array<{
  key: "creates" | "conflicts" | "invalid";
  label: string;
  listLabel: string;
  tone: string;
}> = [
  { key: "creates", label: "新增", listLabel: "新增记录", tone: styles.positive },
  { key: "conflicts", label: "冲突", listLabel: "冲突记录", tone: styles.neutral },
  { key: "invalid", label: "无效", listLabel: "无效记录", tone: styles.negative },
];

function ErrorBanner({ message, onReset }: { message: string; onReset?: () => void }) {
  return (
    <div className={styles.errorBanner} role="alert">
      <span>{message}</span>
      {onReset ? <button type="button" onClick={onReset}>重新选择文件</button> : null}
    </div>
  );
}

function SelectionPanel({
  controller,
  selectedFilename,
  busy = false,
}: {
  controller: GridImportController;
  selectedFilename?: string;
  busy?: boolean;
}) {
  const inputId = useId();
  const stateError = controller.state.stage === "select" ? controller.state.error : null;

  return (
    <>
      {stateError ? <ErrorBanner message={stateError} onReset={controller.reset} /> : null}
      <section className={styles.selectPanel} aria-labelledby={`${inputId}-title`}>
        <div className={styles.panelHeader}>
          <div>
            <span>来源文件</span>
            <h2 id={`${inputId}-title`}>Android / Web JSON</h2>
          </div>
          {selectedFilename ? <code>{selectedFilename}</code> : <code>尚未选择</code>}
        </div>

        <div className={styles.fileControl}>
          <label htmlFor={inputId}>选择 JSON 文件</label>
          <input
            id={inputId}
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void controller.selectFile(file);
              event.currentTarget.value = "";
            }}
          />
          <p>支持 Android 导出的 JSON 数组或 Web 完整备份。文件上限 10 MiB。</p>
        </div>

        <aside className={styles.trustNote}>
          <strong>服务端重新校验</strong>
          <p>文件中的账号归属、网格行与汇总值不会沿用；服务器会按当前账号重新计算。</p>
        </aside>
      </section>
    </>
  );
}

function RecordItem({ item }: { item: ImportPreviewItem }) {
  const fieldErrors = Object.entries(item.fieldErrors ?? {});
  return (
    <li className={styles.recordItem}>
      <div className={styles.recordIdentity}>
        <span>第 {item.index + 1} 条</span>
        <code>{item.productCode || "未提供产品代码"}</code>
      </div>
      {item.warnings?.length ? (
        <ul className={styles.recordMessages} aria-label={`第 ${item.index + 1} 条警告`}>
          {item.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
      {fieldErrors.length ? (
        <ul className={`${styles.recordMessages} ${styles.fieldErrors}`} aria-label={`第 ${item.index + 1} 条字段错误`}>
          {fieldErrors.flatMap(([field, messages]) => messages.map((message) => (
            <li key={`${field}-${message}`}><code>{field}</code>：{message}</li>
          )))}
        </ul>
      ) : null}
    </li>
  );
}

function RecordGroup({
  label,
  items,
  tone,
}: {
  label: string;
  items: ImportPreviewItem[];
  tone: string;
}) {
  return (
    <details className={styles.recordGroup}>
      <summary>
        <span>{label}</span>
        <code className={tone}>{items.length}</code>
      </summary>
      {items.length ? (
        <ol>{items.map((item) => <RecordItem key={`${item.index}-${item.productCode}`} item={item} />)}</ol>
      ) : (
        <p className={styles.emptyGroup}>没有记录</p>
      )}
    </details>
  );
}

function CountStrip({
  preview,
  report,
}: {
  preview?: ImportPreview;
  report?: ImportReport;
}) {
  const counts = preview
    ? [
        { label: "新增", value: preview.creates.length, tone: styles.positive },
        { label: "冲突", value: preview.conflicts.length, tone: styles.neutral },
        { label: "无效", value: preview.invalid.length, tone: styles.negative },
        { label: "警告", value: preview.warnings.length, tone: styles.warning },
      ]
    : [
        { label: "已新增", value: report?.created ?? 0, tone: styles.positive },
        { label: "已覆盖", value: report?.overwritten ?? 0, tone: styles.negative },
        { label: "已跳过", value: report?.skipped ?? 0, tone: styles.neutral },
        { label: "无效", value: report?.invalid ?? 0, tone: styles.negative },
      ];

  return (
    <ul className={styles.countStrip} aria-label={preview ? "导入预检统计" : "导入结果统计"}>
      {counts.map((count) => (
        <li key={count.label}>
          <span>{count.label}</span>
          <code className={count.tone}>{count.value}</code>
        </li>
      ))}
    </ul>
  );
}

function PreviewContent({
  filename,
  preview,
  policy,
  error = null,
  busy = false,
  onPolicyChange,
  onCommit,
  onReset,
  commitTriggerRef,
}: PreviewContentProps) {
  return (
    <>
      {error ? <ErrorBanner message={error} /> : null}
      <section className={styles.previewPanel} aria-labelledby="import-preview-title">
        <div className={styles.panelHeader}>
          <div>
            <span>预检文件</span>
            <h2 id="import-preview-title">导入影响</h2>
          </div>
          <code>{filename}</code>
        </div>

        <CountStrip preview={preview} />

        <div className={styles.recordGroups}>
          {previewGroups.map((group) => (
            <RecordGroup
              key={group.key}
              label={group.listLabel}
              items={preview[group.key]}
              tone={group.tone}
            />
          ))}
          <details className={styles.recordGroup}>
            <summary>
              <span>预检警告</span>
              <code className={styles.warning}>{preview.warnings.length}</code>
            </summary>
            {preview.warnings.length ? (
              <ul className={styles.globalWarnings}>
                {preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            ) : (
              <p className={styles.emptyGroup}>没有警告</p>
            )}
          </details>
        </div>

        <fieldset className={styles.policy} disabled={busy}>
          <legend>冲突处理</legend>
          <label>
            <input
              type="radio"
              name="policy"
              value="skip"
              checked={policy === "skip"}
              onChange={() => onPolicyChange("skip")}
            />
            <span><strong>跳过冲突（推荐）</strong><small>保留当前账号已有产品</small></span>
          </label>
          <label className={styles.overwriteOption}>
            <input
              type="radio"
              name="policy"
              value="overwrite"
              checked={policy === "overwrite"}
              onChange={() => onPolicyChange("overwrite")}
            />
            <span><strong>覆盖冲突</strong><small>替换当前账号同代码产品</small></span>
          </label>
        </fieldset>

        <div className={styles.actions}>
          <button type="button" disabled={busy} onClick={onReset}>重新选择文件</button>
          <button
            ref={commitTriggerRef}
            type="button"
            className={policy === "overwrite" ? styles.riskAction : styles.primaryAction}
            disabled={busy}
            onClick={onCommit}
          >
            开始导入
          </button>
        </div>
      </section>
    </>
  );
}

function OverwriteConfirmation({
  busy,
  onConfirm,
  onClose,
}: {
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const busyRef = useRef(busy);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const close = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  useEffect(() => {
    cancelRef.current?.focus();
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
        'a[href]:not([aria-disabled="true"]), button:not(:disabled), [tabindex]:not([tabindex="-1"])',
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
    };
  }, [close]);

  useEffect(() => {
    if (busy) dialogRef.current?.focus();
  }, [busy]);

  return (
    <div ref={layerRef} className={styles.dialogLayer}>
      <button
        type="button"
        className={styles.dialogBackdrop}
        aria-label="关闭覆盖确认弹窗"
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
        <header>
          <span>高风险操作</span>
          <h2 id={titleId}>确认覆盖现有产品</h2>
        </header>
        <div className={styles.dialogBody}>
          <p id={descriptionId}>此操作会替换当前账号中同代码产品，原有参数和计算结果无法从本次导入中恢复。</p>
          <p>建议先保存当前数据，再继续不可撤销的覆盖操作。</p>
          <a
            href={apiPath("/grid-trades/export?format=web")}
            aria-disabled={busy ? "true" : undefined}
            tabIndex={busy ? -1 : undefined}
            onClick={(event) => {
              if (busy) event.preventDefault();
            }}
          >
            先下载 Web 完整备份
          </a>
        </div>
        <footer>
          <button ref={cancelRef} type="button" disabled={busy} onClick={close}>取消</button>
          <button
            type="button"
            className={styles.confirmOverwrite}
            disabled={busy}
            aria-busy={busy}
            onClick={onConfirm}
          >
            {busy ? "正在覆盖导入…" : "确认覆盖并导入"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function BusyOverlay({ message }: { message: string }) {
  return (
    <div className={styles.busyOverlay} role="status" aria-live="polite">
      <div className={styles.busyIndicator}>
        <span className={styles.spinner} aria-hidden="true" />
        <span>{message}</span>
      </div>
    </div>
  );
}

function Completion({ report }: { report: ImportReport }) {
  return (
    <section className={styles.completePanel} aria-labelledby="import-complete-title">
      <span className={styles.completeEyebrow}>导入完成</span>
      <h2 id="import-complete-title">服务器数据已更新</h2>
      <p>以下结果已写入当前账号，无效记录没有写入。</p>
      <CountStrip report={report} />
      <div className={styles.actions}>
        <Link className={styles.primaryAction} href="/grids">返回产品列表</Link>
      </div>
    </section>
  );
}

export function ImportWorkspace({ controller: injectedController }: ImportWorkspaceProps = {}) {
  const liveController = useGridImport();
  const controller = injectedController ?? liveController;
  const [overwriteOpen, setOverwriteOpen] = useState(false);
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false);
  const commitTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreTriggerFocus = useRef(false);
  const state = controller.state;
  const busy = state.stage === "previewing" || state.stage === "committing";

  const closeOverwrite = useCallback(() => {
    restoreTriggerFocus.current = true;
    setOverwriteOpen(false);
  }, []);

  useEffect(() => {
    if (!overwriteOpen && restoreTriggerFocus.current) {
      restoreTriggerFocus.current = false;
      commitTriggerRef.current?.focus();
    }
  }, [overwriteOpen]);

  async function confirmOverwrite() {
    if (confirmingOverwrite) return;
    setConfirmingOverwrite(true);
    try {
      await controller.commit("overwrite");
    } finally {
      setConfirmingOverwrite(false);
      closeOverwrite();
    }
  }

  function requestCommit() {
    if (state.stage !== "preview") return;
    if (state.policy === "overwrite") {
      setOverwriteOpen(true);
      return;
    }
    void controller.commit("skip");
  }

  return (
    <section className={styles.workspace} aria-label="导入工作区" aria-busy={busy}>
      <div className={styles.workspaceContent}>
        <header className={styles.heading}>
          <div>
            <span className={styles.eyebrow}>Data transfer</span>
            <h1>导入网格数据</h1>
          </div>
          <p>选择文件后先预检，再决定如何处理当前账号中的同代码产品。</p>
        </header>

        <ol className={styles.stateRail} aria-label="导入步骤">
          <li aria-current={state.stage === "select" || state.stage === "previewing" ? "step" : undefined}>选择文件</li>
          <li aria-current={state.stage === "preview" ? "step" : undefined}>预检</li>
          <li aria-current={state.stage === "committing" || state.stage === "complete" ? "step" : undefined}>导入</li>
        </ol>

        {state.stage === "select" ? <SelectionPanel controller={controller} /> : null}
        {state.stage === "previewing" ? (
          <SelectionPanel controller={controller} selectedFilename={state.filename} busy />
        ) : null}
        {state.stage === "preview" || state.stage === "committing" ? (
          <PreviewContent
            filename={state.filename}
            preview={state.preview}
            policy={state.policy}
            error={state.stage === "preview" ? state.error : null}
            busy={state.stage === "committing"}
            onPolicyChange={controller.setPolicy}
            onCommit={requestCommit}
            onReset={controller.reset}
            commitTriggerRef={commitTriggerRef}
          />
        ) : null}
        {state.stage === "complete" ? <Completion report={state.report} /> : null}
      </div>

      {state.stage === "previewing" ? <BusyOverlay message="正在预检文件…" /> : null}
      {state.stage === "committing" ? <BusyOverlay message="正在导入数据…" /> : null}
      {overwriteOpen ? (
        <OverwriteConfirmation
          busy={confirmingOverwrite || state.stage === "committing"}
          onConfirm={() => void confirmOverwrite()}
          onClose={closeOverwrite}
        />
      ) : null}
    </section>
  );
}
