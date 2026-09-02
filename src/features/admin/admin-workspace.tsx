"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { ClientApiError } from "@/lib/api-client";
import { lockDocumentForModal } from "@/lib/modal-isolation";

import { createInvitation as createInvitationRequest } from "./admin-api";
import type { CreatedInvitation, ManagedUser } from "./types";
import { useAdminUsers, type AdminUserListController } from "./use-admin-users";
import styles from "./admin.module.css";

type CreateInvitation = (
  expiresInHours: number,
  signal?: AbortSignal,
) => Promise<CreatedInvitation>;

type VisibleError = {
  message: string;
  requestId?: string;
  retryAfterSeconds?: number;
};

type StatusConfirmation = {
  user: ManagedUser;
  status: ManagedUser["status"];
};

const createdAtFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Shanghai",
});

function displayCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = Object.fromEntries(
    createdAtFormatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function visibleError(error: unknown, fallback: string): VisibleError {
  if (error instanceof ClientApiError) {
    return {
      message: error.message,
      requestId: error.requestId,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  return { message: error instanceof TypeError ? "网络连接失败，请重试" : fallback };
}

function ErrorMessage({ error }: { error: VisibleError }) {
  return (
    <p className={styles.error} role="alert">
      <span>{error.message}</span>
      {error.requestId ? <small>请求 ID：{error.requestId}</small> : null}
      {error.retryAfterSeconds ? <small>{error.retryAfterSeconds} 秒后可重试</small> : null}
    </p>
  );
}

export function AdminWorkspace({ currentUserId }: { currentUserId: string }) {
  const controller = useAdminUsers();
  return <AdminWorkspaceView currentUserId={currentUserId} controller={controller} />;
}

export function AdminWorkspaceView({
  currentUserId,
  controller,
  createInvitation = createInvitationRequest,
}: {
  currentUserId: string;
  controller: AdminUserListController;
  createInvitation?: CreateInvitation;
}) {
  const [ttl, setTtl] = useState("24");
  const [ttlError, setTtlError] = useState("");
  const [invitation, setInvitation] = useState<CreatedInvitation | null>(null);
  const [invitationError, setInvitationError] = useState<VisibleError | null>(null);
  const [invitationPending, setInvitationPending] = useState(false);
  const [invitationRetryAfter, setInvitationRetryAfter] = useState(0);
  const [copyFeedback, setCopyFeedback] = useState<"" | "copied" | "manual">("");
  const [confirmation, setConfirmation] = useState<StatusConfirmation | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<VisibleError | null>(null);
  const invitationLock = useRef(false);
  const statusLock = useRef(false);
  const invitationController = useRef<AbortController | null>(null);
  const statusController = useRef<AbortController | null>(null);
  const invitationGeneration = useRef(0);
  const statusGeneration = useRef(0);
  const mounted = useRef(false);
  const inviteInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const lifetimeInvitationGeneration = invitationGeneration;
    const lifetimeStatusGeneration = statusGeneration;
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++lifetimeInvitationGeneration.current;
      ++lifetimeStatusGeneration.current;
      invitationController.current?.abort();
      statusController.current?.abort();
      invitationController.current = null;
      statusController.current = null;
      invitationLock.current = false;
      statusLock.current = false;
    };
  }, []);

  useEffect(() => {
    if (invitationRetryAfter <= 0) return;
    const timer = window.setInterval(() => {
      setInvitationRetryAfter((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [invitationRetryAfter]);

  async function submitInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invitationLock.current || invitationRetryAfter > 0) return;
    const hours = Number(ttl);
    if (!/^\d+$/.test(ttl) || !Number.isSafeInteger(hours) || hours < 1 || hours > 168) {
      setTtlError("有效期必须是 1–168 之间的整数");
      return;
    }

    invitationLock.current = true;
    setInvitationPending(true);
    setTtlError("");
    setInvitationError(null);
    setCopyFeedback("");
    setInvitation(null);
    const requestGeneration = ++invitationGeneration.current;
    const requestController = new AbortController();
    invitationController.current = requestController;

    try {
      const created = await createInvitation(hours, requestController.signal);
      if (!mounted.current || requestGeneration !== invitationGeneration.current) return;
      setInvitation(created);
    } catch (error) {
      if (!mounted.current || requestGeneration !== invitationGeneration.current) return;
      if (error instanceof Error && error.name === "AbortError") return;
      const publicError = visibleError(error, "创建邀请失败，请重试");
      setInvitationError(publicError);
      setInvitationRetryAfter(publicError.retryAfterSeconds ?? 0);
    } finally {
      if (invitationController.current === requestController) invitationController.current = null;
      if (mounted.current && requestGeneration === invitationGeneration.current) {
        invitationLock.current = false;
        setInvitationPending(false);
      }
    }
  }

  async function copyInvitation() {
    if (!invitation) return;
    setCopyFeedback("");
    const input = inviteInputRef.current;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(invitation.inviteUrl);
      if (mounted.current) setCopyFeedback("copied");
    } catch {
      input?.focus();
      input?.select();
      if (mounted.current) setCopyFeedback("manual");
    }
  }

  const closeConfirmation = useCallback(() => {
    if (statusLock.current) return;
    setStatusError(null);
    setConfirmation(null);
  }, []);

  async function confirmStatusChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmation || statusLock.current) return;
    statusLock.current = true;
    setPendingUserId(confirmation.user.id);
    setStatusError(null);
    const requestGeneration = ++statusGeneration.current;
    const requestController = new AbortController();
    statusController.current = requestController;

    try {
      await controller.updateStatus(
        confirmation.user.id,
        confirmation.status,
        requestController.signal,
      );
      if (!mounted.current || requestGeneration !== statusGeneration.current) return;
      setConfirmation(null);
    } catch (error) {
      if (!mounted.current || requestGeneration !== statusGeneration.current) return;
      if (error instanceof Error && error.name === "AbortError") return;
      setStatusError(visibleError(error, "账号状态更新失败，请重试"));
    } finally {
      if (statusController.current === requestController) statusController.current = null;
      if (mounted.current && requestGeneration === statusGeneration.current) {
        statusLock.current = false;
        setPendingUserId(null);
      }
    }
  }

  return (
    <section className={styles.workspace} aria-labelledby="admin-title">
      <header className={styles.heading}>
        <div>
          <p>Access ledger · 已载入 {controller.items.length} 个账号</p>
          <h1 id="admin-title">账号管理</h1>
        </div>
        <span className={styles.authority}>管理员权限已验证</span>
      </header>

      <section className={styles.invitationStrip} aria-labelledby="invitation-title">
        <div className={styles.invitationIntro}>
          <span>Private access</span>
          <h2 id="invitation-title">创建一次性邀请</h2>
          <p>链接只在当前页面显示。新邀请会替换上一条链接。</p>
        </div>
        <form className={styles.invitationForm} onSubmit={submitInvitation} noValidate>
          <label htmlFor="admin-invitation-ttl">邀请有效期（小时）</label>
          <div className={styles.invitationControls}>
            <input
              id="admin-invitation-ttl"
              name="expiresInHours"
              type="number"
              min="1"
              max="168"
              step="1"
              inputMode="numeric"
              value={ttl}
              aria-invalid={!!ttlError}
              aria-describedby={ttlError ? "admin-invitation-ttl-error" : "admin-invitation-ttl-hint"}
              onChange={(event) => {
                setTtl(event.target.value);
                setTtlError("");
              }}
            />
            <button type="submit" disabled={invitationPending || invitationRetryAfter > 0}>
              {invitationPending
                ? "正在创建邀请…"
                : invitationRetryAfter > 0
                  ? `${invitationRetryAfter} 秒后重试`
                  : invitation
                    ? "创建新邀请"
                    : "创建邀请"}
            </button>
          </div>
          {ttlError ? <span id="admin-invitation-ttl-error" className={styles.fieldError}>{ttlError}</span> : null}
          {!ttlError ? <small id="admin-invitation-ttl-hint">允许 1–168 小时，默认 24 小时</small> : null}
          {invitationError ? <ErrorMessage error={invitationError} /> : null}
        </form>
      </section>

      {invitation ? (
        <section className={styles.invitationResult} aria-labelledby="new-invitation-title">
          <div>
            <span>Ready once</span>
            <h2 id="new-invitation-title">新邀请已创建</h2>
          </div>
          <div className={styles.copyArea}>
            <label htmlFor="admin-invite-url">新邀请链接</label>
            <input
              ref={inviteInputRef}
              id="admin-invite-url"
              readOnly
              value={invitation.inviteUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" onClick={() => void copyInvitation()}>复制邀请链接</button>
            <small>有效至 <time dateTime={invitation.expiresAt}>{displayCreatedAt(invitation.expiresAt)}</time></small>
            {copyFeedback === "copied" ? <p role="status">邀请链接已复制</p> : null}
            {copyFeedback === "manual" ? (
              <p role="alert">无法自动复制，请选中上方链接并手动复制。</p>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className={styles.ledger} aria-labelledby="ledger-title">
        <header className={styles.ledgerHeading}>
          <div>
            <span>Identity / role / status</span>
            <h2 id="ledger-title">身份与状态账本</h2>
          </div>
          <span aria-live="polite">{controller.items.length} 项</span>
        </header>

        {controller.initialError && !controller.items.length ? (
          <div className={styles.listError} role="alert">
            <span>{controller.initialError}</span>
            <button type="button" onClick={() => void controller.retryInitial()}>重试加载</button>
          </div>
        ) : null}

        {controller.initialLoading && !controller.items.length ? (
          <div className={styles.loading} role="status">正在加载账号…</div>
        ) : null}

        {!controller.initialLoading && !controller.initialError && !controller.items.length ? (
          <div className={styles.empty} role="region" aria-label="账号清单空状态">
            <p>还没有可管理的账号</p>
            <span>创建邀请后，新账号会出现在这里。</span>
          </div>
        ) : null}

        {controller.items.length ? (
          <div className={styles.tableViewport} role="region" aria-label="账号清单滚动区域">
            <table className={styles.userTable} aria-label="账号清单">
              <caption className={styles.srOnly}>账号名称、角色、状态、创建时间和状态操作</caption>
              <thead>
                <tr>
                  <th scope="col">账号名称</th>
                  <th scope="col">角色</th>
                  <th scope="col">状态</th>
                  <th scope="col">创建时间</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {controller.items.map((user) => {
                  const targetStatus = user.status === "active" ? "disabled" : "active";
                  const isSelfDisable = user.id === currentUserId && targetStatus === "disabled";
                  const isPending = pendingUserId === user.id;
                  return (
                    <tr key={user.id} className={user.status === "active" ? styles.activeRow : styles.disabledRow}>
                      <td className={styles.username}>{user.username}</td>
                      <td>
                        <span className={user.role === "admin" ? styles.adminRole : styles.memberRole}>
                          {user.role === "admin" ? "管理员" : "普通用户"}
                        </span>
                      </td>
                      <td>
                        <span className={user.status === "active" ? styles.activeStatus : styles.disabledStatus}>
                          {user.status === "active" ? "启用" : "禁用"}
                        </span>
                      </td>
                      <td className={styles.timestamp}>
                        <time dateTime={user.createdAt}>{displayCreatedAt(user.createdAt)}</time>
                      </td>
                      <td className={styles.actionCell}>
                        {isSelfDisable ? <span className={styles.selfLabel}>当前账号</span> : null}
                        <button
                          type="button"
                          disabled={isSelfDisable || isPending}
                          aria-label={isSelfDisable
                            ? `不能禁用 ${user.username}（当前账号）`
                            : `${targetStatus === "disabled" ? "禁用" : "启用"} ${user.username}`}
                          onClick={() => {
                            setStatusError(null);
                            setConfirmation({ user, status: targetStatus });
                          }}
                        >
                          {isPending
                            ? "处理中…"
                            : targetStatus === "disabled"
                              ? "禁用"
                              : "启用"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className={styles.pagination} aria-live="polite">
          {controller.pageError ? (
            <div role="alert">
              <span>{controller.pageError}</span>
              <button type="button" onClick={() => void controller.retryPage()}>重试加载更多</button>
            </div>
          ) : controller.nextCursor ? (
            <button
              type="button"
              disabled={controller.pageLoading}
              onClick={() => void controller.loadMore()}
            >
              {controller.pageLoading ? "正在加载更多账号…" : "加载更多账号"}
            </button>
          ) : controller.items.length ? (
            <span>已显示全部账号</span>
          ) : null}
        </div>
      </section>

      {confirmation ? (
        <StatusConfirmationDialog
          confirmation={confirmation}
          pending={pendingUserId === confirmation.user.id}
          error={statusError}
          onClose={closeConfirmation}
          onConfirm={confirmStatusChange}
        />
      ) : null}
    </section>
  );
}

function StatusConfirmationDialog({
  confirmation,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  confirmation: StatusConfirmation;
  pending: boolean;
  error: VisibleError | null;
  onClose: () => void;
  onConfirm: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const pendingRef = useRef(pending);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();
  const action = confirmation.status === "disabled" ? "禁用" : "启用";

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    cancelRef.current?.focus();
    const restoreDocument = layerRef.current
      ? lockDocumentForModal(layerRef.current)
      : () => undefined;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!pendingRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
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
  }, []);

  return (
    <div ref={layerRef} className={styles.modalLayer}>
      <button
        type="button"
        className={styles.backdrop}
        aria-label="关闭账号状态确认"
        tabIndex={-1}
        disabled={pending}
        onClick={onClose}
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
        <form onSubmit={onConfirm}>
          <span>Account status</span>
          <h2 id={titleId}>确认{action}账号</h2>
          <p id={descriptionId}>
            {confirmation.status === "disabled"
              ? `禁用后，${confirmation.user.username} 的所有会话将立即撤销。`
              : `启用后，${confirmation.user.username} 可以再次登录。`}
          </p>
          {error ? <ErrorMessage error={error} /> : null}
          <div className={styles.dialogActions}>
            <button ref={cancelRef} type="button" disabled={pending} onClick={onClose}>取消</button>
            <button type="submit" disabled={pending} className={confirmation.status === "disabled" ? styles.danger : styles.enable}>
              {pending ? `正在${action}…` : `确认${action}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
