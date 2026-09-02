"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ClientApiError, type FieldErrors } from "@/lib/api-client";
import { acceptInvitation, getInvitationStatus } from "./invitation-api";
import type { InvitationRegistrationUser, InvitationStatus } from "./types";
import styles from "./invitation.module.css";

export type InvitationPageState =
  | { kind: "loading" }
  | { kind: "valid" | "used" | "expired"; expiresAt: string | null }
  | { kind: "invalid"; expiresAt?: null }
  | {
      kind: "error";
      message: string;
      requestId?: string;
      retryAfterSeconds?: number;
    };

type StatusRequest = (token: string, signal?: AbortSignal) => Promise<InvitationStatus>;
type AcceptRequest = (
  token: string,
  username: string,
  password: string,
  signal?: AbortSignal,
) => Promise<InvitationRegistrationUser>;
type FormAcceptRequest = (
  username: string,
  password: string,
  signal?: AbortSignal,
) => Promise<InvitationRegistrationUser>;

const unavailableAccept: FormAcceptRequest = () => Promise.reject(
  new Error("Invitation acceptance is unavailable"),
);

function requestIdSuffix(requestId?: string): string {
  return requestId ? ` 请求 ID：${requestId}` : "";
}

function stateFromError(caught: unknown): InvitationPageState {
  if (caught instanceof ClientApiError && [404, 422].includes(caught.status)) {
    return { kind: "invalid", expiresAt: null };
  }
  if (caught instanceof ClientApiError) {
    return {
      kind: "error",
      message: caught.message,
      requestId: caught.requestId,
      retryAfterSeconds: caught.retryAfterSeconds,
    };
  }
  return { kind: "error", message: "网络连接失败，请重试" };
}

export function InvitationPage({
  token,
  getStatus = getInvitationStatus,
  accept = acceptInvitation,
  replace,
}: {
  token: string;
  getStatus?: StatusRequest;
  accept?: AcceptRequest;
  replace?: (path: string) => void;
}) {
  const router = useRouter();
  const navigate = replace ?? router.replace;
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{
    token: string;
    reload: number;
    state: InvitationPageState;
  } | null>(null);
  const state = loaded?.token === token && loaded.reload === reload
    ? loaded.state
    : { kind: "loading" as const };

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    getStatus(token, controller.signal).then(
      (status) => {
        if (active) {
          setLoaded({
            token,
            reload,
            state: { kind: status.status, expiresAt: status.expiresAt },
          });
        }
      },
      (caught: unknown) => {
        if (active && !controller.signal.aborted) {
          setLoaded({ token, reload, state: stateFromError(caught) });
        }
      },
    );

    return () => {
      active = false;
      controller.abort();
    };
  }, [getStatus, reload, token]);

  return (
    <InvitationPageView
      key={`${token}:${reload}`}
      state={state}
      accept={(username, password, signal) => accept(token, username, password, signal)}
      onAccepted={() => navigate("/login")}
      onRetry={() => setReload((value) => value + 1)}
    />
  );
}

export function InvitationPageView({
  state,
  accept = unavailableAccept,
  onAccepted = () => undefined,
  onRetry = () => undefined,
}: {
  state: InvitationPageState;
  accept?: FormAcceptRequest;
  onAccepted?: () => void;
  onRetry?: () => void;
}) {
  if (state.kind === "loading") {
    return (
      <InvitationFrame step="verify">
        <section className={styles.statusPanel} role="status" aria-live="polite">
          <span className={styles.spinner} aria-hidden="true" />
          <h1>正在验证邀请</h1>
          <p>正在确认这条邀请是否仍然有效。</p>
        </section>
      </InvitationFrame>
    );
  }

  if (state.kind === "error") {
    return <RetryableStatusPanel state={state} onRetry={onRetry} />;
  }

  if (state.kind !== "valid") {
    return <TerminalInvitationState kind={state.kind} />;
  }

  return (
    <ValidInvitationState
      state={{ kind: "valid", expiresAt: state.expiresAt }}
      accept={accept}
      onAccepted={onAccepted}
    />
  );
}

function ValidInvitationState({
  state,
  accept,
  onAccepted,
}: {
  state: { kind: "valid"; expiresAt: string | null };
  accept: FormAcceptRequest;
  onAccepted: () => void;
}) {
  const [acceptanceInvalid, setAcceptanceInvalid] = useState(false);

  if (acceptanceInvalid) return <TerminalInvitationState kind="invalid" />;

  return (
    <InvitationFrame step="account">
      <section className={styles.formPanel} aria-labelledby="invite-title">
        <div className={styles.formHeading}>
          <p className={styles.eyebrow}>邀请有效</p>
          <h1 id="invite-title">创建你的账户</h1>
          <p>设置登录凭据即可加入 FitGrid。我们不会展示邀请方或其他账号信息。</p>
          {state.expiresAt ? (
            <p className={styles.expiry}>有效期至 <time dateTime={state.expiresAt}>{readableTime(state.expiresAt)}</time></p>
          ) : null}
        </div>
        <RegistrationForm
          accept={accept}
          onAccepted={onAccepted}
          onInvalid={() => setAcceptanceInvalid(true)}
        />
      </section>
    </InvitationFrame>
  );
}

function TerminalInvitationState({ kind }: { kind: "used" | "expired" | "invalid" }) {
  const copy = statusCopy(kind);
  return (
    <InvitationFrame step="verify">
      <section className={styles.statusPanel}>
        <span className={`${styles.statusMark} ${styles.errorMark}`} aria-hidden="true">!</span>
        <h1>{copy.title}</h1>
        <p>{copy.detail}</p>
        <Link className={styles.secondaryAction} href="/login">前往登录</Link>
      </section>
    </InvitationFrame>
  );
}

function RetryableStatusPanel({
  state,
  onRetry,
}: {
  state: Extract<InvitationPageState, { kind: "error" }>;
  onRetry: () => void;
}) {
  const [retryAfter, setRetryAfter] = useState(Math.max(0, state.retryAfterSeconds ?? 0));
  const retryLock = useRef(false);

  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = window.setTimeout(() => {
      setRetryAfter((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [retryAfter]);

  function retry() {
    if (retryAfter > 0 || retryLock.current) return;
    retryLock.current = true;
    onRetry();
  }

  return (
    <InvitationFrame step="verify">
      <section className={styles.statusPanel}>
        <span className={`${styles.statusMark} ${styles.errorMark}`} aria-hidden="true">!</span>
        <h1>暂时无法验证邀请</h1>
        <p className={styles.publicError} role="alert">
          {state.message}{requestIdSuffix(state.requestId)}
          {retryAfter > 0 ? ` ${retryAfter} 秒后重试。` : ""}
        </p>
        <button
          className={styles.secondaryAction}
          type="button"
          aria-label="重新检查邀请"
          disabled={retryAfter > 0}
          onClick={retry}
        >
          {retryAfter > 0 ? `${retryAfter} 秒后重试` : "重新检查邀请"}
        </button>
      </section>
    </InvitationFrame>
  );
}

function RegistrationForm({
  accept,
  onAccepted,
  onInvalid,
}: {
  accept: FormAcceptRequest;
  onAccepted: () => void;
  onInvalid: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
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
    const timer = window.setTimeout(() => setRetryAfter((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [retryAfter]);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    const normalizedUsername = username.trim();
    if (normalizedUsername.length < 3 || normalizedUsername.length > 64) {
      errors.username = ["用户名长度必须为 3–64 个字符"];
    }
    if (password.length < 12 || password.length > 128) {
      errors.password = ["密码长度必须为 12–128 个字符"];
    }
    if (confirmation !== password) {
      errors.confirmation = ["两次输入的密码不一致"];
    }
    return errors;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionLock.current || retryAfter > 0) return;

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
      await accept(username.trim(), password, controller.signal);
    } catch (caught) {
      if (!isCurrent()) return;
      const hasCredentialFieldErrors = caught instanceof ClientApiError
        && ["username", "password", "confirmation"]
          .some((field) => caught.fieldErrors?.[field]?.length);
      if (caught instanceof ClientApiError
        && (caught.status === 404 || (caught.status === 422 && !hasCredentialFieldErrors))) {
        setPassword("");
        setConfirmation("");
        onInvalid();
      } else if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors ?? {});
        setRetryAfter(caught.status === 429 ? caught.retryAfterSeconds ?? 1 : 0);
        setFormError(`${caught.message}${requestIdSuffix(caught.requestId)}`);
      } else {
        setFormError("网络连接失败，请重试");
      }
      submissionLock.current = false;
      setPending(false);
      activeController.current = null;
      return;
    }

    if (!isCurrent()) return;
    activeController.current = null;
    setPassword("");
    setConfirmation("");
    setAccepted(true);
    onAccepted();
  }

  if (accepted) {
    return (
      <section className={styles.inlineStatus} role="status" aria-live="polite">
        <span className={`${styles.statusMark} ${styles.successMark}`} aria-hidden="true">✓</span>
        <h1>账号已创建</h1>
        <p>正在进入登录页。请使用刚刚创建的账号登录。</p>
      </section>
    );
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <InvitationField
        id="invite-username"
        label="用户名"
        error={fieldErrors.username?.[0]}
      >
        <input
          id="invite-username"
          name="username"
          autoComplete="username"
          minLength={3}
          maxLength={64}
          aria-invalid={!!fieldErrors.username}
          aria-describedby={fieldErrors.username ? "invite-username-error" : undefined}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </InvitationField>
      <InvitationField
        id="invite-password"
        label="密码"
        hint="12–128 个字符"
        error={fieldErrors.password?.[0]}
      >
        <input
          id="invite-password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          aria-invalid={!!fieldErrors.password}
          aria-describedby={fieldErrors.password ? "invite-password-error" : "invite-password-hint"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </InvitationField>
      <InvitationField
        id="invite-confirmation"
        label="确认密码"
        error={fieldErrors.confirmation?.[0]}
      >
        <input
          id="invite-confirmation"
          name="passwordConfirmation"
          type="password"
          autoComplete="new-password"
          maxLength={128}
          aria-invalid={!!fieldErrors.confirmation}
          aria-describedby={fieldErrors.confirmation ? "invite-confirmation-error" : undefined}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </InvitationField>
      {formError ? (
        <p className={styles.publicError} role="alert">
          {formError}{retryAfter > 0 ? ` ${retryAfter} 秒后可重试。` : ""}
        </p>
      ) : null}
      <button className={styles.primaryAction} disabled={pending || retryAfter > 0}>
        {pending ? "正在创建…" : retryAfter > 0 ? `${retryAfter} 秒后重试` : "创建账号"}
      </button>
    </form>
  );
}

function InvitationFrame({ step, children }: { step: "verify" | "account" | "signin"; children: ReactNode }) {
  return (
    <main className={styles.page}>
      <article className={styles.card}>
        <header className={styles.header}>
          <Link className={styles.wordmark} href="/login" aria-label="FitGrid 登录页">
            <span aria-hidden="true">FG</span>
            <strong>FitGrid</strong>
          </Link>
          <span className={styles.publicLabel}>PUBLIC ACCESS</span>
        </header>
        <ol className={styles.rail} aria-label="账号创建进度">
          <RailStep label="验证邀请" active={step === "verify"} complete={step !== "verify"} />
          <RailStep label="创建账号" active={step === "account"} complete={step === "signin"} />
          <RailStep label="登录工作台" active={step === "signin"} complete={false} />
        </ol>
        {children}
      </article>
    </main>
  );
}

function RailStep({ label, active, complete }: { label: string; active: boolean; complete: boolean }) {
  return (
    <li className={active ? styles.activeStep : complete ? styles.completeStep : undefined}>
      <span aria-hidden="true" />
      {label}
    </li>
  );
}

function InvitationField({
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
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? <span id={`${id}-error`} className={styles.fieldError}>{error}</span> : null}
      {!error && hint ? <span id={`${id}-hint`} className={styles.hint}>{hint}</span> : null}
    </div>
  );
}

function statusCopy(kind: "used" | "expired" | "invalid") {
  if (kind === "used") {
    return { title: "邀请已使用", detail: "这条邀请已经完成注册，不能再次创建账号。" };
  }
  if (kind === "expired") {
    return { title: "邀请已过期", detail: "邀请已超过有效期，请联系管理员重新创建。" };
  }
  return { title: "邀请无效或已失效", detail: "请检查链接是否完整，或联系管理员获取新邀请。" };
}

function readableTime(value: string): string {
  return value.replace("T", " ").replace(/\.000Z$/, " UTC");
}
