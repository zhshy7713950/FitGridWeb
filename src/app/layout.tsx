import type { Metadata } from "next";
import type { ReactNode } from "react";
import { themeInitializationScript } from "@/components/theme/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "FitGrid 策略工作台",
  description: "私有网格策略计算与管理",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN" data-theme="light" suppressHydrationWarning>
      <head>
        <script id="fitgrid-theme-init" dangerouslySetInnerHTML={{ __html: themeInitializationScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
