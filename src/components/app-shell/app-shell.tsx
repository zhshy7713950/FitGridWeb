"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode, type SVGProps } from "react";
import { GridIcon } from "@/components/icons";
import type { SessionUser } from "@/features/auth/types";
import { browserBasePath } from "@/lib/app-paths";
import { LogoutButton } from "./logout-button";
import styles from "./app-shell.module.css";

function AlertIcon(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" {...props}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" /></svg>;
}

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

function DataIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" {...props}>
      <ellipse cx="12" cy="5" rx="7" ry="3" />
      <path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" />
    </svg>
  );
}

function appPathname(pathname: string): string {
  const basePath = browserBasePath();
  if (basePath && pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return pathname;
}

function hierarchicalBackLink(pathname: string): { href: string; label: string } | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  const segments = normalized.split("/").filter(Boolean);

  if (segments[0] === "price-alerts") {
    if (segments.length === 3 && segments[2] === "edit") return { href: `/price-alerts/${segments[1]}`, label: "返回提醒详情" };
    if (segments.length === 2) return { href: "/price-alerts", label: "返回股价提醒" };
  }
  if (segments[0] !== "grids") return null;
  if (segments.length === 3 && segments[2] === "edit") {
    return { href: `/grids/${segments[1]}`, label: "返回产品详情" };
  }
  if (segments.length === 2) {
    return { href: "/grids", label: "返回网格产品" };
  }
  return null;
}

export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }) {
  const pathname = appPathname(usePathname());
  const gridsCurrent = pathname === "/grids" || pathname.startsWith("/grids/");
  const backLink = hierarchicalBackLink(pathname);
  const navigationRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navigationRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return (
    <div className={styles.shell}>
      <header className={styles.accountBar}>
        {backLink ? (
          <Link className={styles.backAction} href={backLink.href}>
            <span aria-hidden="true">←</span>
            <span>{backLink.label}</span>
          </Link>
        ) : (
          <span className={styles.mobileBrand}>FitGrid</span>
        )}
        <span className={styles.connection}>安全连接</span>
        <span className={styles.username} title={user.username}>
          {user.username}
        </span>
        <span className={styles.role}>{user.role === "admin" ? "管理员" : "普通用户"}</span>
        <LogoutButton />
      </header>
      <nav ref={navigationRef} aria-label="主导航" className={styles.rail}>
        <div className={styles.logo} aria-label="FitGrid">
          FG
        </div>
        <Link href="/grids" aria-current={gridsCurrent ? "page" : undefined}>
          <GridIcon />
          <span>网格产品</span>
        </Link>
        <Link href="/price-alerts" aria-current={pathname === "/price-alerts" || pathname.startsWith("/price-alerts/") ? "page" : undefined}>
          <AlertIcon /><span>股价提醒</span>
        </Link>
        {user.role === "admin" ? (
          <>
            <Link href="/admin" aria-current={pathname === "/admin" ? "page" : undefined}>
              <AccountsIcon />
              <span>账号管理</span>
            </Link>
            <Link href="/admin/data" aria-current={pathname === "/admin/data" ? "page" : undefined}>
              <DataIcon />
              <span>数据管理</span>
            </Link>
          </>
        ) : null}
        <Link href="/settings/notifications" aria-current={pathname === "/settings/notifications" ? "page" : undefined}>
          <AlertIcon /><span>通知设置</span>
        </Link>
        <Link href="/settings/security" aria-current={pathname === "/settings/security" ? "page" : undefined}>
          <SecurityIcon />
          <span>安全设置</span>
        </Link>
      </nav>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
