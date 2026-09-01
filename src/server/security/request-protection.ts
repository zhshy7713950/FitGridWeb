import { ApiError } from "@/server/http/api-error";

interface WindowEntry {
  count: number;
  resetAt: number;
}

function rateLimited(retryAfterSeconds: number): ApiError {
  return new ApiError(
    429,
    "RATE_LIMITED",
    "请求过于频繁，请稍后重试",
    undefined,
    { "retry-after": String(Math.max(1, retryAfterSeconds)) },
  );
}

function retryAfter(entry: WindowEntry, now: number): number {
  return Math.ceil((entry.resetAt - now) / 1_000);
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, WindowEntry>();

  constructor(
    private readonly limit: number,
    private readonly windowMilliseconds: number,
    private readonly clock: () => number = Date.now,
  ) {}

  consume(key: string): void {
    const now = this.clock();
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMilliseconds });
      return;
    }
    if (current.count >= this.limit) throw rateLimited(retryAfter(current, now));
    current.count += 1;
  }
}

export class LoginAttemptLimiter {
  private readonly failures = new Map<string, WindowEntry>();

  constructor(
    private readonly limit: number,
    private readonly windowMilliseconds: number,
    private readonly clock: () => number = Date.now,
  ) {}

  check(key: string): void {
    const now = this.clock();
    const current = this.failures.get(key);
    if (!current || current.resetAt <= now) {
      if (current) this.failures.delete(key);
      return;
    }
    if (current.count >= this.limit) throw rateLimited(retryAfter(current, now));
  }

  recordFailure(key: string): void {
    const now = this.clock();
    const current = this.failures.get(key);
    if (!current || current.resetAt <= now) {
      this.failures.set(key, { count: 1, resetAt: now + this.windowMilliseconds });
      return;
    }
    current.count += 1;
  }

  clear(key: string): void {
    this.failures.delete(key);
  }
}

export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim()
    || headers.get("x-real-ip")
    || "unknown";
}

export function assertSameOrigin(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return;
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.slice(0, -1);
  if (!origin || !host) throw new ApiError(403, "CROSS_SITE_REQUEST", "拒绝跨站请求");
  let actualOrigin: string;
  try {
    actualOrigin = new URL(origin).origin;
  } catch {
    throw new ApiError(403, "CROSS_SITE_REQUEST", "拒绝跨站请求");
  }
  if (actualOrigin !== `${protocol}://${host}`) {
    throw new ApiError(403, "CROSS_SITE_REQUEST", "拒绝跨站请求");
  }
}

export const loginAttempts = new LoginAttemptLimiter(5, 15 * 60 * 1_000);
export const invitationStatusRequests = new FixedWindowRateLimiter(30, 60 * 1_000);
export const invitationAcceptRequests = new FixedWindowRateLimiter(10, 60 * 60 * 1_000);
export const importPreviewRequests = new FixedWindowRateLimiter(5, 60 * 1_000);
export const ownerMutationRequests = new FixedWindowRateLimiter(60, 60 * 1_000);
