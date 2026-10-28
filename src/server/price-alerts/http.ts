import { z } from "zod";
import { ApiError } from "@/server/http/api-error";
import { requireSession } from "@/server/auth/session";
import { apiHandler, json } from "@/server/http/route-factory";
import { getRuntimeServices } from "@/server/runtime/services";
import { assertMaintenanceAvailable } from "@/server/maintenance/http";
import { FixedWindowRateLimiter, ownerMutationRequests } from "@/server/security/request-protection";
import type { PriceAlertService } from "./service";

export const instrumentRequests = new FixedWindowRateLimiter(10, 60000);
export const barkTestRequests = new FixedWindowRateLimiter(3, 60000);
export const uuid = z.uuid();
export async function parseAlertBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new ApiError(400, "CONTENT_TYPE_INVALID", "请求必须使用 application/json");
  const tooLarge = () => new ApiError(413, "REQUEST_TOO_LARGE", "预警请求不得超过 16 KiB");
  if (Number(request.headers.get("content-length")) > 16384) throw tooLarge();
  const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    if (reader) for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 16384) throw tooLarge(); chunks.push(value); }
  } finally { await reader?.cancel().catch(() => {}); }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
  catch { throw new ApiError(400, "JSON_INVALID", "请求 JSON 无效"); }
}
export function alertRoute(request: Request, handler: (service: PriceAlertService, ownerId: string) => Promise<unknown>, status = 200) {
  return apiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const owner = await requireSession(request.headers, services.auth);
    assertMaintenanceAvailable(await services.maintenance.getMaintenanceMode());
    if (!["GET", "HEAD"].includes(request.method)) ownerMutationRequests.consume(owner.id);
    const body = await handler(services.alerts, owner.id);
    const response = status === 204 ? new Response(null, { status }) : json(body, status, requestId);
    response.headers.set("cache-control", "no-store, private");
    return response;
  });
}
