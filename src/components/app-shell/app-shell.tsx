import Link from "next/link";
import type { ReactNode } from "react";
import { GridIcon } from "@/components/icons";
import type { SessionUser } from "@/features/auth/types";
import { LogoutButton } from "./logout-button";
import styles from "./app-shell.module.css";

export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <nav aria-label="主导航" className={styles.rail}>
        <div className={styles.logo} aria-label="FitGrid">
          FG
        </div>
        <Link href="/grids" aria-current="page">
          <GridIcon />
          <span>网格产品</span>
        </Link>
      </nav>
      <header className={styles.accountBar}>
        <span className={styles.mobileBrand}>FitGrid</span>
        <span className={styles.connection}>安全连接</span>
        <span>{user.username}</span>
        <span>{user.role === "admin" ? "管理员" : "普通用户"}</span>
        <LogoutButton />
      </header>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
