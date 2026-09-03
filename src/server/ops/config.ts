import { z } from "zod";

const secret = z.string().min(32).refine(
  (value) => !/replace|change.?me/i.test(value),
  "秘密仍是示例或默认值",
);
const privateHostPath = z.string().regex(
  /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/,
  "主机路径必须是规范的绝对路径",
);
const numericNonRootGid = z.string()
  .regex(/^[0-9]+$/, "GID 必须只包含十进制数字")
  .transform(Number)
  .pipe(z.number().int().min(1).max(2147483647));
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
  ADMIN_OPS_WEB_DIR: privateHostPath,
  ADMIN_OPS_ROOT_DIR: privateHostPath,
  PORTABLE_BACKUP_DIR: privateHostPath,
  PORTABLE_BACKUP_HISTORY_FILE: privateHostPath,
  PORTABLE_BACKUP_MAX_BYTES: z.coerce.number().int().positive().safe(),
  PORTABLE_BACKUP_READER_GID: numericNonRootGid,
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
  if (parsed.PORTABLE_BACKUP_HISTORY_FILE !== `${parsed.ADMIN_OPS_WEB_DIR}/status/backups.json`) {
    throw new Error("便携备份历史必须位于管理员状态目录");
  }
  const overlaps = (left: string, right: string) => (
    left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
  );
  if (
    overlaps(parsed.ADMIN_OPS_WEB_DIR, parsed.ADMIN_OPS_ROOT_DIR)
    || overlaps(parsed.ADMIN_OPS_WEB_DIR, parsed.PORTABLE_BACKUP_DIR)
    || overlaps(parsed.ADMIN_OPS_ROOT_DIR, parsed.PORTABLE_BACKUP_DIR)
  ) {
    throw new Error("网页任务目录不得包含 root 状态或便携备份目录");
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
