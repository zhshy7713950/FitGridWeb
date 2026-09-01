import { ApiError, toErrorResponse } from "./api-error";
import { requestIdFromHeaders } from "./request-context";

export interface ApiContext {
  requestId: string;
}

export async function apiHandler(
  request: Request,
  handler: (context: ApiContext) => Response | Promise<Response>,
): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  try {
    const response = await handler({ requestId });
    response.headers.set("x-request-id", requestId);
    return response;
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export function json(
  body: unknown,
  status: number,
  requestId: string,
  headers?: HeadersInit,
): Response {
  return Response.json(body, {
    status,
    headers: { ...Object.fromEntries(new Headers(headers)), "x-request-id": requestId },
  });
}

export function noContent(requestId: string, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("x-request-id", requestId);
  return new Response(null, { status: 204, headers: responseHeaders });
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new ApiError(400, "CONTENT_TYPE_INVALID", "请求必须使用 application/json");
  }
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "JSON_INVALID", "请求 JSON 无效");
  }
}
