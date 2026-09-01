"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ClientApiError } from "@/lib/api-client";
import { safeReturnPath, withBasePath } from "@/lib/app-paths";
import { login } from "./login-api";
import styles from "./login.module.css";

type LoginRequest = typeof login;
type Navigate = (path: string) => void;

export function LoginForm({
  returnTo,
  request = login,
  navigate = (path) => window.location.replace(withBasePath(path as `/${string}`)),
}: { returnTo: string; request?: LoginRequest; navigate?: Navigate }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [retryAfter, setRetryAfter] = useState(0);

  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = window.setTimeout(() => {
      const next = retryAfter - 1;
      setRetryAfter(next);
      if (next === 0) setError("");
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [retryAfter]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || retryAfter > 0) return;
    setPending(true);
    setError("");
    setFieldErrors({});
    try {
      await request(username, password);
      navigate(safeReturnPath(returnTo));
    } catch (caught) {
      setPassword("");
      if (caught instanceof ClientApiError && caught.status === 422) {
        setFieldErrors(caught.fieldErrors ?? {});
        setError("请检查标记字段");
      } else if (caught instanceof ClientApiError && caught.status === 429) {
        const seconds = caught.retryAfterSeconds ?? 1;
        setRetryAfter(seconds);
        setError(caught.message);
      } else if (caught instanceof ClientApiError && caught.status === 401) {
        setError("用户名或密码错误");
      } else {
        setError(caught instanceof ClientApiError && caught.requestId
          ? `服务暂时不可用，请求 ID：${caught.requestId}`
          : "网络连接失败，请重试");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <div className={styles.field}>
        <label htmlFor="username">用户名</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          aria-invalid={!!fieldErrors.username}
          aria-describedby={fieldErrors.username ? "username-error" : undefined}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        {fieldErrors.username && <span id="username-error">{fieldErrors.username[0]}</span>}
      </div>
      <div className={styles.field}>
        <label htmlFor="password">密码</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={!!fieldErrors.password}
          aria-describedby={fieldErrors.password ? "password-error" : undefined}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {fieldErrors.password && <span id="password-error">{fieldErrors.password[0]}</span>}
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {retryAfter > 0 ? `${error}，${retryAfter} 秒后重试` : error}
        </p>
      )}
      <button className={styles.submit} disabled={pending || retryAfter > 0}>
        {pending ? "正在登录…" : "登录工作台"}
      </button>
    </form>
  );
}
