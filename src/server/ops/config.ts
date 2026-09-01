import { z } from "zod";

const secret = z.string().min(32);
const deploymentSchema = z.strictObject({
  DOMAIN: z.string().regex(/^(?!https?:\/\/)[a-z0-9.-]+(?::[0-9]+)?$/i),
  APP_IMAGE: z.string().min(1).refine(
    (value) => /(?:@sha256:[a-f0-9]{64}|:[a-z0-9][a-z0-9._-]*)$/i.test(value) && !/:latest$/i.test(value),
    "APP_IMAGE 必须使用不可变的非 latest 标签或 sha256 digest",
  ),
  POSTGRES_DB: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  POSTGRES_USER: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  POSTGRES_PASSWORD: secret.refine(
    (value) => !["password", "postgres", "changeme", "change-me"].includes(value.toLowerCase()),
    "POSTGRES_PASSWORD 不能使用默认值",
  ),
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
  return parsed;
}

export function validateRestoreTarget(target: string, productionUrl?: string): string {
  if (!target || target === productionUrl) {
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
  return target;
}
