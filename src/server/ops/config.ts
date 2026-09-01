import { z } from "zod";

const secret = z.string().min(32).refine(
  (value) => !/replace|change.?me/i.test(value),
  "秘密仍是示例或默认值",
);
const deploymentSchema = z.strictObject({
  DOMAIN: z.string().regex(/^(?!https?:\/\/)[a-z0-9.-]+$/i),
  APP_BASE_PATH: z.literal("/fitgrid"),
  APP_PORT: z.coerce.number().int().min(1024).max(65535),
  PUBLIC_HTTPS_PORT: z.coerce.number().int().min(1).max(65535),
  BETTER_AUTH_URL: z.url({ protocol: /^https$/ }),
  APP_IMAGE: z.string().min(1).refine(
    (value) => /(?:@sha256:[a-f0-9]{64}|:sha-[a-f0-9]{40})$/i.test(value),
    "APP_IMAGE 必须使用完整 commit SHA 标签或 sha256 digest",
  ),
  POSTGRES_DB: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  POSTGRES_USER: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  POSTGRES_PASSWORD: secret.refine(
    (value) => !["password", "postgres", "changeme", "change-me"].includes(value.toLowerCase()),
    "POSTGRES_PASSWORD 不能使用默认值",
  ),
  APP_DATABASE_USER: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  APP_DATABASE_PASSWORD: secret,
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  MIGRATION_DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  BETTER_AUTH_SECRET: secret,
  OWNER_REF_SECRET: secret,
});

export type DeploymentEnvironment = z.output<typeof deploymentSchema>;

export function validateDeploymentEnvironment(
  value: Record<string, string | undefined>,
): DeploymentEnvironment {
  const parsed = deploymentSchema.parse(value);
  if (parsed.BETTER_AUTH_SECRET === parsed.OWNER_REF_SECRET) {
    throw new Error("BETTER_AUTH_SECRET 与 OWNER_REF_SECRET 必须相互独立");
  }
  const publicPort = parsed.PUBLIC_HTTPS_PORT === 443 ? "" : `:${parsed.PUBLIC_HTTPS_PORT}`;
  const expectedAuthUrl = `https://${parsed.DOMAIN}${publicPort}${parsed.APP_BASE_PATH}`;
  if (parsed.BETTER_AUTH_URL !== expectedAuthUrl) {
    throw new Error(`BETTER_AUTH_URL 必须是 ${expectedAuthUrl}`);
  }
  const runtime = new URL(parsed.DATABASE_URL);
  const migration = new URL(parsed.MIGRATION_DATABASE_URL);
  const credentials = [
    [runtime, parsed.APP_DATABASE_USER, parsed.APP_DATABASE_PASSWORD, "DATABASE_URL"],
    [migration, parsed.POSTGRES_USER, parsed.POSTGRES_PASSWORD, "MIGRATION_DATABASE_URL"],
  ] as const;
  for (const [url, username, password, name] of credentials) {
    if (
      decodeURIComponent(url.username) !== username
      || decodeURIComponent(url.password) !== password
      || url.pathname.replace(/^\//, "") !== parsed.POSTGRES_DB
    ) {
      throw new Error(`${name} 的账号、密码和数据库名必须与独立配置一致`);
    }
  }
  if (parsed.APP_DATABASE_USER === parsed.POSTGRES_USER) {
    throw new Error("运行角色与迁移角色必须分离");
  }
  return parsed;
}

export function validateRestoreTarget(
  target: string,
  productionUrl?: string,
  migrationProductionUrl?: string,
): string {
  if (!target || target === productionUrl || target === migrationProductionUrl) {
    throw new Error("恢复目标不能为空或指向当前生产数据库");
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error("恢复目标必须是 PostgreSQL URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("恢复目标必须是 PostgreSQL URL");
  }
  const database = url.pathname.replace(/^\//, "");
  if (!database || ["postgres", "template0", "template1"].includes(database)) {
    throw new Error("恢复目标必须是独立的命名数据库");
  }
  for (const protectedUrl of [productionUrl, migrationProductionUrl]) {
    if (!protectedUrl) continue;
    const production = new URL(protectedUrl);
    if (
      url.hostname === production.hostname
      && (url.port || "5432") === (production.port || "5432")
      && url.pathname === production.pathname
    ) {
      throw new Error("恢复目标不能通过不同凭据指向当前生产数据库");
    }
  }
  return target;
}
