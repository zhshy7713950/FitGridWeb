import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionSecret(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("通知加密密钥未配置，请运行新版安装器");
  return Buffer.from(value, "hex");
}
export function encryptKey(key: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionSecret(secret), iv);
  const encrypted = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
export function decryptKey(value: string, secret: string): string {
  const [version, nonce, tag, ciphertext, extra] = value.split(".");
  if (version !== "v1" || !nonce || !tag || !ciphertext || extra) throw new Error("通知配置无法解密");
  const decipher = createDecipheriv("aes-256-gcm", encryptionSecret(secret), Buffer.from(nonce, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
export interface BarkPayload { id: string; title: string; body: string; url: string }
export interface BarkResult { accepted: boolean; permanent: boolean; error: string | null; retryAfterSeconds?: number; ambiguous?: boolean }
export async function sendBark(key: string, payload: BarkPayload, options: { url?: string; timeoutMs?: number; signal?: AbortSignal; beforeRequest?: () => Promise<void> } = {}): Promise<BarkResult> {
  await options.beforeRequest?.();
  try {
    const response = await fetch(options.url ?? "https://api.day.app/push", {
      method: "POST", redirect: "error", headers: { "content-type": "application/json" },
      signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 5000), ...(options.signal ? [options.signal] : [])]),
      body: JSON.stringify({ ...payload, device_key: key, group: "FitGrid 股价预警", level: "active" }),
    });
    const reader = response.body?.getReader(); let text = "";
    try { if (reader) for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); if (text.length > 65536) throw new Error("response too large"); } }
    finally { await reader?.cancel().catch(() => {}); }
    let code: unknown;
    try { code = (JSON.parse(text) as { code?: unknown }).code; } catch { /* Non-JSON cannot acknowledge delivery. */ }
    if (response.status === 200 && code === 200) return { accepted: true, permanent: false, error: null };
    const retry = response.headers.get("retry-after");
    const retryAfter = retry ? (/^\d+$/.test(retry) ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000)) : NaN;
    const permanent = response.status !== 429 && response.status < 500 && (response.status >= 400 || typeof code === "number" && code >= 400 && code < 500 && code !== 429);
    return { accepted: false, permanent, error: "Bark 拒绝请求或未返回成功业务状态", ...(Number.isFinite(retryAfter) ? { retryAfterSeconds: Math.max(0, retryAfter) } : {}) };
  } catch {
    return { accepted: false, permanent: false, ambiguous: true, error: "Bark 请求失败或超时，接收状态未知" };
  }
}
