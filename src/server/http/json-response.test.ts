import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";

import { ApiError, toErrorResponse } from "@/server/http/api-error";
import { requestIdFromHeaders } from "@/server/http/request-context";

describe("API error responses", () => {
  it("preserves a valid caller request ID", async () => {
    const requestId = requestIdFromHeaders(new Headers({ "x-request-id": "req_12345678" }));
    const response = toErrorResponse(new ApiError(404, "GRID_TRADE_NOT_FOUND", "Not found"), requestId);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "GRID_TRADE_NOT_FOUND",
      message: "Not found",
      requestId: "req_12345678",
    });
  });

  it("replaces an illegal request ID", () => {
    expect(requestIdFromHeaders(new Headers({ "x-request-id": "cookie=secret value" }))).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{26}$/,
    );
  });

  it("maps Zod field issues to the validation envelope", async () => {
    let error: ZodError;
    try {
      z.object({ productCode: z.string().min(1) }).parse({ productCode: "" });
      throw new Error("expected parsing to fail");
    } catch (caught) {
      error = caught as ZodError;
    }

    const response = toErrorResponse(error, "req_12345678");
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      code: "VALIDATION_FAILED",
      message: "请求字段校验失败",
      fieldErrors: { productCode: [expect.any(String)] },
      requestId: "req_12345678",
    });
  });
});
