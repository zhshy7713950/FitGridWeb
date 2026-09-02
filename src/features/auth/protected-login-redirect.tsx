"use client";

import { useEffect } from "react";

import { browserUnauthorizedRedirect } from "@/lib/app-paths";

import styles from "./login.module.css";

export function ProtectedLoginRedirect() {
  useEffect(() => {
    browserUnauthorizedRedirect();
  }, []);

  return (
    <main className={styles.page}>
      <p role="status">正在进入登录页…</p>
    </main>
  );
}
