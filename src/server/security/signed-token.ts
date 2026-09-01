import { createHmac, timingSafeEqual } from "node:crypto";

import { ApiError } from "@/server/http/api-error";

export interface ScopedTokenPayload {
  exp: number;
  ownerId?: string;
  [key: string]: unknown;
}

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function signScopedToken<T extends ScopedTokenPayload>(payload: T, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signature(encoded, secret).toString("base64url")}`;
}

export function verifyScopedToken<T extends ScopedTokenPayload = ScopedTokenPayload>(
  token: string,
  secret: string,
  options: { ownerId?: string; now?: number } = {},
): T {
  const [encoded, suppliedSignature, extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra) {
    throw new ApiError(400, "SIGNED_TOKEN_INVALID", "签名令牌无效");
  }

  const expected = signature(encoded, secret);
  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedSignature, "base64url");
  } catch {
    throw new ApiError(400, "SIGNED_TOKEN_INVALID", "签名令牌无效");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ApiError(400, "SIGNED_TOKEN_INVALID", "签名令牌无效");
  }

  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  } catch {
    throw new ApiError(400, "SIGNED_TOKEN_INVALID", "签名令牌无效");
  }
  if (!Number.isSafeInteger(payload.exp)) {
    throw new ApiError(400, "SIGNED_TOKEN_INVALID", "签名令牌无效");
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    throw new ApiError(400, "SIGNED_TOKEN_EXPIRED", "签名令牌已过期");
  }
  if (options.ownerId !== undefined && payload.ownerId !== options.ownerId) {
    throw new ApiError(400, "SIGNED_TOKEN_INVALID", "签名令牌无效");
  }
  return payload;
}
