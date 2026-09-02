import Link from "next/link";
import type { ReactNode, SVGProps } from "react";
import { GridIcon } from "@/components/icons";
import type { SessionUser } from "@/features/auth/types";
import { LogoutButton } from "./logout-button";
import styles from "./app-shell.module.css";

function SecurityIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" {...props}>
      <path d="M12 3 5 6v5c0 4.6 2.8 8.2 7 10 4.2-1.8 7-5.4 7-10V6l-7-3Z" />
      <path d="M9.5 12.2 11.2 14l3.6-4" />
    </svg>
  );
}

function AccountsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c.4-3.4 2.2-5 5.5-5s5.1 1.6 5.5 5M16 7h5M18.5 4.5v5" />
    </svg>
  );
}

export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.accountBar}>
        <span className={styles.mobileBrand}>FitGrid</span>
        <span className={styles.connection}>安全连接</span>
        <span className={styles.username} title={user.username}>
          {user.username}
        </span>
        <span className={styles.role}>{user.role === "admin" ? "管理员" : "普通用户"}</span>
        <LogoutButton />
      </header>
      <nav aria-label="主导航" className={styles.rail}>
        <div className={styles.logo} aria-label="FitGrid">
          FG
        </div>
        <Link href="/grids" aria-current="page">
          <GridIcon />
          <span>网格产品</span>
        </Link>
        <Link href="/settings/security">
          <SecurityIcon />
          <span>安全设置</span>
        </Link>
        {user.role === "admin" ? (
          <Link href="/admin">
            <AccountsIcon />
            <span>账号管理</span>
          </Link>
        ) : null}
      </nav>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
