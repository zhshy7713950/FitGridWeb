"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";

import { withBasePath } from "@/lib/app-paths";
import { ClientApiError } from "@/lib/api-client";
import { lockDocumentForModal } from "@/lib/modal-isolation";

import {
  checkMaintenanceHealth,
  confirmRestore as confirmRestoreRequest,
  createPortableBackup,
  getMaintenanceJob,
  issueBackupDownload,
  listPortableBackups,
  uploadRestoreForInspection,
} from "./maintenance-api";
import type {
  ConfirmRestoreInput,
  CreatePortableBackupInput,
  MaintenanceJobStatus,
  PortableBackupList,
  PortableBackupSummary,
  QueuedMaintenanceJob,
} from "./types";
import { useMaintenanceJob } from "./use-maintenance-job";
import styles from "./admin.module.css";

type PublicError = {
  message: string;
  requestId?: string;
  retryAfterSeconds?: number;
};

export type MaintenanceApi = {
  listBackups(signal?: AbortSignal): Promise<PortableBackupList>;
  createBackup(
    input: CreatePortableBackupInput,
    signal?: AbortSignal,
  ): Promise<QueuedMaintenanceJob>;
  getJob(jobId: string, signal?: AbortSignal): Promise<MaintenanceJobStatus>;
  issueDownload(backupId: string, signal?: AbortSignal): Promise<string>;
  uploadRestore(
    file: File,
    passphrase: string,
    signal?: AbortSignal,
  ): Promise<QueuedMaintenanceJob>;
  confirmRestore(
    restoreId: string,
    input: ConfirmRestoreInput,
    signal?: AbortSignal,
  ): Promise<QueuedMaintenanceJob>;
  checkHealth(signal?: AbortSignal): Promise<boolean>;
  download(url: string, suggestedFilename: string): void;
  navigate(path: string): void;
  clearClientSession(): void;
};

function portableBackupFilename(createdAt: string): string {
  const timestamp = new Date(createdAt).toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
  return `fitgridweb-${timestamp}.fitgridbackup`;
}

export function downloadMaintenanceArchive(url: string, suggestedFilename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = suggestedFilename;
  anchor.rel = "noopener noreferrer";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

const defaultMaintenanceApi: MaintenanceApi = {
  listBackups: listPortableBackups,
  createBackup: createPortableBackup,
  getJob: getMaintenanceJob,
  issueDownload: issueBackupDownload,
  uploadRestore: uploadRestoreForInspection,
  confirmRestore: confirmRestoreRequest,
  checkHealth: checkMaintenanceHealth,
  download: downloadMaintenanceArchive,
  navigate: (path) => window.location.assign(path),
  clearClientSession: () => window.sessionStorage.clear(),
};

const localTimestamp = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Shanghai",
});

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = Object.fromEntries(
    localTimestamp
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function formatIecSize(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(amount)} ${units[unit]}` : `${amount.toFixed(1)} ${units[unit]}`;
}

function newestFive(items: PortableBackupSummary[]): PortableBackupSummary[] {
  return items
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 5);
}

function publicError(error: unknown, fallback: string): PublicError {
  if (error instanceof ClientApiError) {
    return {
      message: error.message,
      requestId: error.requestId,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  if (error instanceof TypeError) return { message: "网络连接失败，请重试" };
  return { message: fallback };
}

function ErrorNotice({ error }: { error: PublicError }) {
  return (
    <p className={styles.vaultError} role="alert">
      <span>{error.message}</span>
      {error.requestId ? <small>请求 ID：{error.requestId}</small> : null}
      {error.retryAfterSeconds ? <small>{error.retryAfterSeconds} 秒后可重试</small> : null}
    </p>
  );
}

function useVaultModal(
  layerRef: RefObject<HTMLDivElement | null>,
  dialogRef: RefObject<HTMLDivElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  locked: boolean,
  onClose: () => void,
) {
  const lockedRef = useRef(locked);
  const closeRef = useRef(onClose);

  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    initialFocusRef.current?.focus();
    const restoreDocument = layerRef.current
      ? lockDocumentForModal(layerRef.current)
      : () => undefined;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!lockedRef.current) closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
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

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      restoreDocument();
      window.setTimeout(() => previousFocus?.focus(), 0);
    };
  }, [dialogRef, initialFocusRef, layerRef]);
}

function BackupDialog({
  pending,
  error,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  error: PublicError | null;
  onClose(): void;
  onSubmit(input: CreatePortableBackupInput): void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [backupPassword, setBackupPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ backup?: string; confirmation?: string }>({});
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  useVaultModal(layerRef, dialogRef, cancelRef, pending, onClose);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const length = Array.from(backupPassword).length;
    const nextErrors = {
      backup: length < 12 || length > 128 ? "备份密码必须包含 12–128 个字符" : undefined,
      confirmation: backupPassword !== confirmation ? "两次输入的备份密码不一致" : undefined,
    };
    setFieldErrors(nextErrors);
    if (!currentPassword || nextErrors.backup || nextErrors.confirmation) return;
    onSubmit({ currentPassword, backupPassword, confirmBackupPassword: confirmation });
    setCurrentPassword("");
    setBackupPassword("");
    setConfirmation("");
  }

  return (
    <div className={styles.vaultModalLayer} ref={layerRef}>
      <button
        type="button"
        className={styles.vaultBackdrop}
        aria-label="关闭创建备份对话框"
        disabled={pending}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        className={styles.vaultDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <form onSubmit={submit} noValidate>
          <span>Portable custody / 01</span>
          <h2 id={titleId}>创建便携备份</h2>
          <p id={descriptionId}>当前密码确认操作者身份；独立备份密码用于迁移和灾难恢复。</p>
          <div className={styles.vaultFields}>
            <label>
              <span>当前管理员密码</span>
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                disabled={pending}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
            <label>
              <span>独立备份密码</span>
              <input
                type="password"
                autoComplete="new-password"
                value={backupPassword}
                disabled={pending}
                aria-invalid={!!fieldErrors.backup}
                onChange={(event) => {
                  setBackupPassword(event.target.value);
                  setFieldErrors({});
                }}
              />
              {fieldErrors.backup ? <small className={styles.fieldError}>{fieldErrors.backup}</small> : null}
            </label>
            <label>
              <span>再次确认备份密码</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirmation}
                disabled={pending}
                aria-invalid={!!fieldErrors.confirmation}
                onChange={(event) => {
                  setConfirmation(event.target.value);
                  setFieldErrors({});
                }}
              />
              {fieldErrors.confirmation ? (
                <small className={styles.fieldError}>{fieldErrors.confirmation}</small>
              ) : null}
            </label>
          </div>
          {error ? <ErrorNotice error={error} /> : null}
          <div className={styles.vaultDialogActions}>
            <button ref={cancelRef} type="button" disabled={pending} onClick={onClose}>取消</button>
            <button type="submit" className={styles.primaryAction} disabled={pending}>
              {pending ? "正在确认…" : "确认创建"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RestoreConfirmationDialog({
  pending,
  accepted,
  error,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  accepted: boolean;
  error: PublicError | null;
  onClose(): void;
  onSubmit(input: ConfirmRestoreInput): void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [phrase, setPhrase] = useState("");
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const locked = pending || accepted;
  const canConfirm = currentPassword.length > 0 && phrase === "恢复全部数据" && !locked;
  useVaultModal(layerRef, dialogRef, cancelRef, locked, onClose);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canConfirm) return;
    onSubmit({ currentPassword, confirmationPhrase: "恢复全部数据" });
    setCurrentPassword("");
    setPhrase("");
  }

  return (
    <div className={styles.vaultModalLayer} ref={layerRef}>
      <button
        type="button"
        className={styles.vaultBackdrop}
        aria-label="关闭恢复确认对话框"
        disabled={locked}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        className={`${styles.vaultDialog} ${styles.destructiveDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <form onSubmit={submit} noValidate>
          <span>Production replacement / final</span>
          <h2 id={titleId}>确认整库恢复</h2>
          <p id={descriptionId}>这会用已验证备份替换整座生产数据库，所有现有会话都会失效。</p>
          <div className={styles.downtimeWarning}>预计服务会短暂离线。开始后请勿关闭页面。</div>
          <div className={styles.vaultFields}>
            <label>
              <span>当前密码</span>
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                disabled={locked}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
            <label>
              <span>输入“恢复全部数据”以确认</span>
              <input
                type="text"
                autoComplete="off"
                value={phrase}
                disabled={locked}
                onChange={(event) => setPhrase(event.target.value)}
              />
            </label>
          </div>
          {error ? <ErrorNotice error={error} /> : null}
          {accepted ? (
            <p className={styles.maintenanceNotice} role="status">
              服务器正在恢复数据，请勿关闭页面
            </p>
          ) : null}
          <div className={styles.vaultDialogActions}>
            <button ref={cancelRef} type="button" disabled={locked} onClick={onClose}>
              关闭恢复确认
            </button>
            <button type="submit" className={styles.destructiveAction} disabled={!canConfirm}>
              {pending ? "正在接受恢复…" : accepted ? "恢复进行中…" : "确认替换全部数据"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function LifecycleRail({ job }: { job: MaintenanceJobStatus | null }) {
  const stage = job?.state === "ready" ? 2 : job?.state === "encrypting" ? 1 : 0;
  return (
    <ol className={styles.executionRail} aria-label="备份执行阶段">
      {["正在生成", "正在加密", "可以下载"].map((label, index) => (
        <li
          key={label}
          className={index < stage ? styles.completedStage : index === stage ? styles.currentStage : ""}
          aria-current={index === stage && job ? "step" : undefined}
        >
          <span>{String(index + 1).padStart(2, "0")}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

export function DataVault({
  api = defaultMaintenanceApi,
  initialBackups,
}: {
  api?: MaintenanceApi;
  initialBackups?: PortableBackupSummary[];
}) {
  const [backups, setBackups] = useState(() => newestFive(initialBackups ?? []));
  const [historyError, setHistoryError] = useState<PublicError | null>(null);
  const [backupDialogOpen, setBackupDialogOpen] = useState(false);
  const [backupPending, setBackupPending] = useState(false);
  const [backupError, setBackupError] = useState<PublicError | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [pollGeneration, setPollGeneration] = useState(0);
  const [activeOperation, setActiveOperation] = useState<"backup" | "inspection" | "restore" | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadPassword, setUploadPassword] = useState("");
  const [uploadPending, setUploadPending] = useState(false);
  const [uploadError, setUploadError] = useState<PublicError | null>(null);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [restorePending, setRestorePending] = useState(false);
  const [restoreAccepted, setRestoreAccepted] = useState(false);
  const [restoreError, setRestoreError] = useState<PublicError | null>(null);
  const [healthProbe, setHealthProbe] = useState({ generation: 0, recovered: false });
  const mounted = useRef(false);
  const backupLock = useRef(false);
  const uploadLock = useRef(false);
  const restoreLock = useRef(false);
  const maintenanceLock = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const refreshedBackupJob = useRef<string | null>(null);
  const finishedRestoreJob = useRef<string | null>(null);
  const jobController = useMaintenanceJob(activeJobId, api.getJob, pollGeneration);

  useEffect(() => {
    mounted.current = true;
    const ownedControllers = controllers.current;
    return () => {
      mounted.current = false;
      for (const controller of ownedControllers) controller.abort();
      ownedControllers.clear();
      backupLock.current = false;
      uploadLock.current = false;
      restoreLock.current = false;
      maintenanceLock.current = false;
    };
  }, []);

  useEffect(() => {
    if (initialBackups !== undefined) return;
    const controller = new AbortController();
    controllers.current.add(controller);
    void api.listBackups(controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setBackups(newestFive(result.items));
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setHistoryError(publicError(error, "加载历史备份失败"));
      },
    ).finally(() => controllers.current.delete(controller));
    return () => controller.abort();
  }, [api, initialBackups]);

  useEffect(() => {
    const job = jobController.job;
    if (
      job?.type === "backup"
      && job.state === "ready"
      && refreshedBackupJob.current !== job.id
    ) {
      refreshedBackupJob.current = job.id;
      const controller = new AbortController();
      controllers.current.add(controller);
      void api.listBackups(controller.signal).then((result) => {
        if (!controller.signal.aborted) setBackups(newestFive(result.items));
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setHistoryError(publicError(error, "刷新历史备份失败"));
      }).finally(() => controllers.current.delete(controller));
    }
    if (
      job?.type === "restore"
      && job.state === "succeeded"
      && finishedRestoreJob.current !== job.id
    ) {
      finishedRestoreJob.current = job.id;
      api.clearClientSession();
      api.navigate(withBasePath("/login"));
    }
    if (
      job
      && ["ready", "awaiting-confirmation", "succeeded", "failed", "intervention-required"].includes(job.state)
    ) maintenanceLock.current = false;
  }, [api, jobController.job]);

  useEffect(() => {
    if (
      !restoreAccepted
      || (!jobController.disconnected && jobController.error?.status !== 401)
    ) return;
    let active = true;
    let timer: number | null = null;
    let controller: AbortController | null = null;
    const generation = jobController.recoveryGeneration;
    const probe = async () => {
      controller = new AbortController();
      const healthy = await api.checkHealth(controller.signal).catch(() => false);
      if (!active) return;
      setHealthProbe({ generation, recovered: healthy });
      if (!healthy) timer = window.setTimeout(() => void probe(), 5_000);
    };
    void probe();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [
    api,
    jobController.recoveryGeneration,
    jobController.disconnected,
    jobController.error?.status,
    restoreAccepted,
  ]);

  const healthRecovered = healthProbe.generation === jobController.recoveryGeneration
    && healthProbe.recovered;

  useEffect(() => {
    if (
      !restoreAccepted
      || !healthRecovered
      || jobController.error?.status !== 401
      || !activeJobId
      || finishedRestoreJob.current === activeJobId
    ) return;
    finishedRestoreJob.current = activeJobId;
    api.clearClientSession();
    api.navigate(withBasePath("/login"));
  }, [activeJobId, api, healthRecovered, jobController.error?.status, restoreAccepted]);

  const closeBackupDialog = useCallback(() => {
    if (backupLock.current) return;
    setBackupDialogOpen(false);
    setBackupError(null);
  }, []);

  const closeRestoreDialog = useCallback(() => {
    if (restoreLock.current || restoreAccepted) return;
    setRestoreDialogOpen(false);
    setRestoreError(null);
  }, [restoreAccepted]);

  async function submitBackup(input: CreatePortableBackupInput) {
    if (backupLock.current || maintenanceLock.current) return;
    backupLock.current = true;
    maintenanceLock.current = true;
    setBackupPending(true);
    setBackupError(null);
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const queued = await api.createBackup(input, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setActiveOperation("backup");
      setActiveJobId(queued.id);
      setPollGeneration((value) => value + 1);
      setBackupDialogOpen(false);
    } catch (error) {
      maintenanceLock.current = false;
      if (!controller.signal.aborted) setBackupError(publicError(error, "创建备份失败，请重试"));
    } finally {
      controllers.current.delete(controller);
      backupLock.current = false;
      if (mounted.current) setBackupPending(false);
    }
  }

  async function downloadBackup(backup: PortableBackupSummary) {
    const controller = new AbortController();
    controllers.current.add(controller);
    setHistoryError(null);
    try {
      const url = await api.issueDownload(backup.id, controller.signal);
      if (!controller.signal.aborted) api.download(url, portableBackupFilename(backup.createdAt));
    } catch (error) {
      if (!controller.signal.aborted) setHistoryError(publicError(error, "下载备份失败，请重试"));
    } finally {
      controllers.current.delete(controller);
    }
  }

  async function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (uploadLock.current || maintenanceLock.current) return;
    if (!selectedFile || !/^fitgridweb-[0-9]{8}T[0-9]{6}Z\.fitgridbackup$/.test(selectedFile.name)) {
      setUploadError({ message: "请选择有效的 .fitgridbackup 文件" });
      return;
    }
    const length = Array.from(uploadPassword).length;
    if (length < 12 || length > 128) {
      setUploadError({ message: "备份密码必须包含 12–128 个字符" });
      return;
    }
    uploadLock.current = true;
    maintenanceLock.current = true;
    setUploadPending(true);
    setUploadError(null);
    const file = selectedFile;
    const passphrase = uploadPassword;
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const queued = await api.uploadRestore(file, passphrase, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setActiveOperation("inspection");
      setActiveJobId(queued.id);
      setPollGeneration((value) => value + 1);
    } catch (error) {
      maintenanceLock.current = false;
      if (!controller.signal.aborted) setUploadError(publicError(error, "备份预检失败，请重试"));
    } finally {
      controllers.current.delete(controller);
      setUploadPassword("");
      uploadLock.current = false;
      if (mounted.current) setUploadPending(false);
    }
  }

  const inspectionPreview = activeOperation === "inspection"
    && jobController.job?.state === "awaiting-confirmation"
    && jobController.job.preview
    ? jobController.job
    : null;

  async function submitRestore(input: ConfirmRestoreInput) {
    if (!inspectionPreview || restoreLock.current || maintenanceLock.current) return;
    restoreLock.current = true;
    maintenanceLock.current = true;
    setRestorePending(true);
    setRestoreError(null);
    const controller = new AbortController();
    controllers.current.add(controller);
    let accepted = false;
    try {
      const queued = await api.confirmRestore(inspectionPreview.id, input, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      accepted = true;
      setRestoreAccepted(true);
      setHealthProbe({ generation: 0, recovered: false });
      setActiveOperation("restore");
      setActiveJobId(queued.id);
      setPollGeneration((value) => value + 1);
    } catch (error) {
      maintenanceLock.current = false;
      if (!controller.signal.aborted) setRestoreError(publicError(error, "确认恢复失败，请重试"));
    } finally {
      controllers.current.delete(controller);
      if (!accepted) restoreLock.current = false;
      if (mounted.current) setRestorePending(false);
    }
  }

  const backupJob = activeOperation === "backup" ? jobController.job : null;
  const backupBusy = backupPending || (activeOperation === "backup" && backupJob?.state !== "ready"
    && backupJob?.state !== "failed" && backupJob?.state !== "intervention-required");
  const preview = inspectionPreview?.preview;
  const restoreStatus = activeOperation === "restore" ? jobController.job : null;
  const terminalJobError: PublicError | null = jobController.job
    && (jobController.job.state === "failed" || jobController.job.state === "intervention-required")
    ? {
        message: jobController.job.state === "intervention-required"
          ? `维护任务需要人工处理${jobController.job.code ? `：${jobController.job.code}` : ""}`
          : `维护任务失败${jobController.job.code ? `：${jobController.job.code}` : ""}`,
        requestId: jobController.job.requestId,
      }
    : null;
  const globalBusy = backupPending || uploadPending || restorePending || (
    !!activeJobId
    && (
      !jobController.job
      || !["ready", "awaiting-confirmation", "succeeded", "failed", "intervention-required"]
        .includes(jobController.job.state)
    )
  );

  return (
    <section className={styles.dataVault} aria-labelledby="data-vault-title">
      <header className={styles.vaultHeading}>
        <div>
          <span>Data custody / production</span>
          <h2 id="data-vault-title">数据保险库</h2>
        </div>
        <p>创建可迁移的加密快照，或用已验证快照替换整座服务器数据库。</p>
      </header>

      <div className={styles.vaultControls}>
        <section className={styles.vaultControl} aria-labelledby="backup-control-title">
          <div className={styles.controlIndex}>01 / SEAL</div>
          <h3 id="backup-control-title">创建与保管</h3>
          <p>快照覆盖账号、会话、邀请、产品、策略与数据库结构。</p>
          <LifecycleRail job={backupJob} />
          {jobController.error && activeOperation === "backup" ? <ErrorNotice error={jobController.error} /> : null}
          {terminalJobError && activeOperation === "backup" ? <ErrorNotice error={terminalJobError} /> : null}
          <button
            type="button"
            className={styles.primaryAction}
            disabled={backupBusy}
            onClick={() => {
              setBackupError(null);
              setBackupDialogOpen(true);
            }}
          >
            {backupBusy ? "正在创建备份…" : "创建备份"}
          </button>
        </section>

        <section className={`${styles.vaultControl} ${styles.restoreControl}`} aria-labelledby="restore-control-title">
          <div className={styles.controlIndex}>02 / REPLACE</div>
          <h3 id="restore-control-title">上传与整库恢复</h3>
          <p>先隔离解密并检查；只有通过预检的文件才能进入生产替换。</p>
          <form className={styles.restoreUpload} onSubmit={submitUpload} noValidate>
            <label>
              <span>选择便携备份文件</span>
              <input
                type="file"
                accept=".fitgridbackup,application/vnd.fitgrid.backup"
                disabled={globalBusy || restoreAccepted}
                onChange={(event) => {
                  setSelectedFile(event.target.files?.[0] ?? null);
                  setUploadError(null);
                }}
              />
            </label>
            <label>
              <span>备份密码</span>
              <input
                type="password"
                autoComplete="new-password"
                value={uploadPassword}
                disabled={globalBusy || restoreAccepted}
                onChange={(event) => {
                  setUploadPassword(event.target.value);
                  setUploadError(null);
                }}
              />
            </label>
            {uploadError ? <ErrorNotice error={uploadError} /> : null}
            {jobController.error && activeOperation === "inspection" ? (
              <ErrorNotice error={jobController.error} />
            ) : null}
            {terminalJobError && activeOperation === "inspection" ? (
              <ErrorNotice error={terminalJobError} />
            ) : null}
            <button type="submit" disabled={globalBusy || restoreAccepted}>
              {uploadPending || (activeOperation === "inspection" && !inspectionPreview)
                ? "正在检查备份…"
                : "上传并检查"}
            </button>
          </form>
        </section>
      </div>

      {preview ? (
        <section className={styles.restorePreview} aria-labelledby="restore-preview-title">
          <header>
            <div>
              <span>Verified manifest / immutable</span>
              <h3 id="restore-preview-title">恢复预检已通过</h3>
            </div>
            <strong>完整性检查通过</strong>
          </header>
          <dl>
            <div><dt>备份时间</dt><dd>{formatTimestamp(inspectionPreview.backupCreatedAt)}</dd></div>
            <div><dt>PostgreSQL</dt><dd>主版本 {inspectionPreview.postgresMajor ?? "—"}</dd></div>
            <div><dt>数据库</dt><dd>{inspectionPreview.database ?? "—"}</dd></div>
            <div><dt>账号</dt><dd>{preview.users} 个用户</dd></div>
            <div><dt>产品</dt><dd>{preview.gridTrades} 个网格产品</dd></div>
            <div><dt>邀请</dt><dd>{preview.invitations} 个邀请</dd></div>
            <div><dt>导入预检</dt><dd>{preview.importPreviews} 条</dd></div>
          </dl>
          <button
            type="button"
            className={styles.destructiveOutline}
            disabled={restoreAccepted}
            onClick={() => {
              setRestoreError(null);
              setRestoreDialogOpen(true);
            }}
          >
            恢复全部数据
          </button>
        </section>
      ) : null}

      {restoreAccepted ? (
        <div className={styles.restoreRuntime} role="status">
          <strong>服务器正在恢复数据，请勿关闭页面</strong>
          <span>
            {jobController.disconnected
              ? healthRecovered ? "服务已恢复，正在读取最终结果…" : "服务短暂离线，正在检查健康状态…"
              : restoreStatus?.state === "succeeded" ? "恢复完成，正在前往登录页…" : "生产数据正在替换并执行健康检查。"}
          </span>
          {terminalJobError && activeOperation === "restore" ? <ErrorNotice error={terminalJobError} /> : null}
        </div>
      ) : null}

      <section className={styles.backupLedger} aria-labelledby="backup-history-title">
        <header>
          <div>
            <span>Retained copies / max 5</span>
            <h3 id="backup-history-title">历史备份</h3>
          </div>
          <span>{backups.length} / 5</span>
        </header>
        {historyError ? <ErrorNotice error={historyError} /> : null}
        {backups.length ? (
          <ol aria-label="历史备份">
            {backups.map((backup) => {
              const timestamp = formatTimestamp(backup.createdAt);
              return (
                <li key={backup.id}>
                  <time dateTime={backup.createdAt}>{timestamp}</time>
                  <span>{formatIecSize(backup.size)}</span>
                  <code title={backup.sha256}>{backup.sha256.slice(0, 12)}…</code>
                  <button
                    type="button"
                    aria-label={`下载备份 ${timestamp}`}
                    onClick={() => void downloadBackup(backup)}
                  >
                    下载
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className={styles.vaultEmpty}>还没有可下载的完整备份。</p>
        )}
      </section>

      {backupDialogOpen ? (
        <BackupDialog
          pending={backupPending}
          error={backupError}
          onClose={closeBackupDialog}
          onSubmit={(input) => void submitBackup(input)}
        />
      ) : null}
      {restoreDialogOpen ? (
        <RestoreConfirmationDialog
          pending={restorePending}
          accepted={restoreAccepted}
          error={restoreError}
          onClose={closeRestoreDialog}
          onSubmit={(input) => void submitRestore(input)}
        />
      ) : null}
    </section>
  );
}
