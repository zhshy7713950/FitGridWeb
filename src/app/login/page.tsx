import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { LoginBrand } from "@/features/auth/login-brand";
import { LoginForm } from "@/features/auth/login-form";
import { safeReturnPath } from "@/lib/app-paths";
import { getOptionalSession } from "@/server/auth/session";
import styles from "@/features/auth/login.module.css";

export default async function LoginPage({ searchParams }: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const user = await getOptionalSession(await headers());
  if (user) redirect("/grids");

  const raw = (await searchParams).returnTo;
  const returnTo = safeReturnPath(Array.isArray(raw) ? raw[0] : raw);

  return (
    <main className={styles.page}>
      <div className={styles.loginCard}>
        <LoginBrand />
        <section className={styles.panel} aria-labelledby="login-title">
          <h2 id="login-title">登录工作台</h2>
          <p className={styles.panelIntro}>使用受邀账户进入你的网格策略空间。</p>
          <LoginForm returnTo={returnTo} />
        </section>
      </div>
    </main>
  );
}
