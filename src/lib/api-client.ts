import { apiPath, browserUnauthorizedRedirect, type ApiRoute } from "./app-paths";

export type FieldErrors = Record<string, string[]>;

export class ClientApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly fieldErrors?: FieldErrors,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ClientApiError";
  }
}

export async function requestJson<T>(
  path: ApiRoute,
  init: RequestInit = {},
  onUnauthorized: () => void = browserUnauthorizedRedirect,
): Promise<T> {
  const response = await fetch(apiPath(path), {
    ...init,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...init.headers },
  });

  if (response.ok) {
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  if (response.status === 401 && path !== "/auth/login") onUnauthorized();

  const parsedBody: unknown = await response.json().catch(() => ({}));
  const body = (
    parsedBody !== null && typeof parsedBody === "object" && !Array.isArray(parsedBody)
      ? parsedBody
      : {}
  ) as Partial<{
    code: string;
    message: string;
    requestId: string;
    fieldErrors: FieldErrors;
  }>;
  const retry = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);

  throw new ClientApiError(
    response.status,
    body.code ?? "REQUEST_FAILED",
    body.message ?? "请求失败",
    body.requestId,
    body.fieldErrors,
    Number.isFinite(retry) && retry > 0 ? retry : undefined,
  );
}
