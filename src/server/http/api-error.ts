import { ZodError } from "zod";

export type FieldErrors = Record<string, string[]>;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors?: FieldErrors,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function zodFieldErrors(error: ZodError): FieldErrors {
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "body";
    (fields[key] ??= []).push(issue.message);
  }
  return fields;
}

export function toErrorResponse(error: unknown, requestId: string): Response {
  let normalized: ApiError;
  if (error instanceof ApiError) {
    normalized = error;
  } else if (error instanceof ZodError) {
    normalized = new ApiError(
      422,
      "VALIDATION_FAILED",
      "请求字段校验失败",
      zodFieldErrors(error),
    );
  } else {
    normalized = new ApiError(500, "INTERNAL_ERROR", "服务暂时不可用");
  }

  return Response.json(
    {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.fieldErrors ? { fieldErrors: normalized.fieldErrors } : {}),
      requestId,
    },
    { status: normalized.status, headers: { "x-request-id": requestId } },
  );
}
