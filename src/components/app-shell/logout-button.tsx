"use client";

import { useState } from "react";
import { logout } from "@/features/auth/login-api";
import { withBasePath } from "@/lib/app-paths";
import styles from "./app-shell.module.css";

export function LogoutButton({
  request = logout,
  navigate = (path) => window.location.replace(withBasePath(path as `/${string}`)),
}: {
  request?: typeof logout;
  navigate?: (path: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function leave() {
    if (pending) return;

    setPending(true);
    setError("");
    try {
      await request();
      navigate("/login");
    } catch {
      setError("退出失败，请重试");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.logoutArea}>
      <button className={styles.logout} disabled={pending} onClick={leave}>
        {pending ? "正在退出…" : "退出登录"}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
