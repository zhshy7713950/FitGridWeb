"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { ClientApiError, type FieldErrors } from "@/lib/api-client";
import { browserUnauthorizedRedirect } from "@/lib/app-paths";
import { changePassword as changePasswordRequest } from "./account-api";
import styles from "./security.module.css";

type PasswordChange = (
  currentPassword: string,
  newPassword: string,
  signal?: AbortSignal,
) => Promise<void>;

function requestIdSuffix(requestId?: string): string {
  return requestId ? ` 请求 ID：${requestId}` : "";
}

export function SecurityPage({
  changePassword = changePasswordRequest,
}: {
  changePassword?: PasswordChange;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const [pending, setPending] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);
  const submissionLock = useRef(false);
  const mounted = useRef(false);
  const requestGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
      activeController.current?.abort();
      activeController.current = null;
    };
  }, []);

  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = window.setTimeout(() => {
      setRetryAfter((value) => Math.max(0, value - 1));
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [retryAfter]);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (currentPassword.length === 0) {
      errors.currentPassword = ["请输入当前密码"];
    }
    if (newPassword.length < 12 || newPassword.length > 128) {
      errors.newPassword = ["新密码长度必须为 12–128 个字符"];
    }
    if (confirmation !== newPassword) {
      errors.confirmation = ["两次输入的新密码不一致"];
    }
    return errors;
  }

  function clearFieldError(field: string): void {
    setFieldErrors((errors) => {
      if (!errors[field]) return errors;
      const next = { ...errors };
      delete next[field];
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionLock.current || retryAfter > 0 || succeeded) return;

    const errors = validate();
    setFieldErrors(errors);
    setFormError("");
    if (Object.keys(errors).length > 0) return;

    submissionLock.current = true;
    setPending(true);
    const controller = new AbortController();
    const generation = ++requestGeneration.current;
    activeController.current = controller;
    const isCurrent = () => mounted.current
      && requestGeneration.current === generation
      && activeController.current === controller
      && !controller.signal.aborted;

    try {
      await changePassword(currentPassword, newPassword, controller.signal);
    } catch (caught) {
      if (!isCurrent()) return;
      setCurrentPassword("");

      if (caught instanceof ClientApiError) {
        const serverErrors = { ...(caught.fieldErrors ?? {}) };
        if (caught.code === "CURRENT_PASSWORD_INVALID") {
          serverErrors.currentPassword = [caught.message];
        }
        setFieldErrors(serverErrors);
        setRetryAfter(caught.status === 429 ? caught.retryAfterSeconds ?? 1 : 0);
        setFormError(`${caught.message}${requestIdSuffix(caught.requestId)}`);
        if (caught.status === 401 && caught.code !== "CURRENT_PASSWORD_INVALID") {
          browserUnauthorizedRedirect();
        }
      } else {
        setFieldErrors({});
        setRetryAfter(0);
        setFormError("网络连接失败，请重试");
      }

      activeController.current = null;
      submissionLock.current = false;
      setPending(false);
      return;
    }

    if (!isCurrent()) return;
    activeController.current = null;
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
    setSucceeded(true);
  }

  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>账户 / 安全</p>
          <h1>修改密码</h1>
          <p className={styles.lede}>更新登录凭据，并撤销其他设备上的会话。</p>
        </div>
        <div className={styles.securityState} aria-label="当前连接状态：安全">
          <span className={styles.signal} aria-hidden="true" />
          <span>会话保护已启用</span>
        </div>
      </header>

      <section className={styles.operation} aria-labelledby="password-operation-title">
        <div className={styles.context}>
          <p className={styles.operationLabel}>安全操作</p>
          <h2 id="password-operation-title">验证当前凭据</h2>
          <p>新密码长度为 12–128 个字符。更新完成后，当前设备保持登录，其他设备需要重新登录。</p>
          <dl className={styles.sessionPolicy}>
            <div>
              <dt>当前设备</dt>
              <dd>保持会话</dd>
            </div>
            <div>
              <dt>其他设备</dt>
              <dd>撤销会话</dd>
            </div>
          </dl>
        </div>

        {succeeded ? (
          <section className={styles.success} role="status" aria-live="polite">
            <span aria-hidden="true">✓</span>
            <div>
              <h2>密码更新完成</h2>
              <p>密码已更新，其他设备的会话已撤销</p>
            </div>
          </section>
        ) : (
          <form className={styles.form} onSubmit={submit} noValidate>
            <SecurityField
              id="security-current-password"
              label="当前密码"
              error={fieldErrors.currentPassword?.[0]}
            >
              <input
                id="security-current-password"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                maxLength={128}
                value={currentPassword}
                aria-invalid={!!fieldErrors.currentPassword}
                aria-describedby={fieldErrors.currentPassword ? "security-current-password-error" : undefined}
                onChange={(event) => {
                  setCurrentPassword(event.target.value);
                  clearFieldError("currentPassword");
                }}
              />
            </SecurityField>

            <SecurityField
              id="security-new-password"
              label="新密码"
              hint="12–128 个字符"
              error={fieldErrors.newPassword?.[0]}
            >
              <input
                id="security-new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                value={newPassword}
                aria-invalid={!!fieldErrors.newPassword}
                aria-describedby={fieldErrors.newPassword ? "security-new-password-error" : "security-new-password-hint"}
                onChange={(event) => {
                  setNewPassword(event.target.value);
                  clearFieldError("newPassword");
                }}
              />
            </SecurityField>

            <SecurityField
              id="security-confirmation"
              label="确认新密码"
              error={fieldErrors.confirmation?.[0]}
            >
              <input
                id="security-confirmation"
                name="passwordConfirmation"
                type="password"
                autoComplete="new-password"
                maxLength={128}
                value={confirmation}
                aria-invalid={!!fieldErrors.confirmation}
                aria-describedby={fieldErrors.confirmation ? "security-confirmation-error" : undefined}
                onChange={(event) => {
                  setConfirmation(event.target.value);
                  clearFieldError("confirmation");
                }}
              />
            </SecurityField>

            {formError ? (
              <p className={styles.publicError} role="alert">
                {formError}{retryAfter > 0 ? ` ${retryAfter} 秒后可重试。` : ""}
              </p>
            ) : null}

            <button className={styles.submit} disabled={pending || retryAfter > 0}>
              {pending ? "正在更新…" : retryAfter > 0 ? `${retryAfter} 秒后重试` : "修改密码"}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

function SecurityField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <span className={styles.fieldError} id={`${id}-error`}>{error}</span>
      ) : hint ? (
        <span className={styles.hint} id={`${id}-hint`}>{hint}</span>
      ) : null}
    </div>
  );
}
