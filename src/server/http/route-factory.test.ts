import { describe, expect, it } from "vitest";

import { ApiError } from "@/server/http/api-error";
import { apiHandler, json, parseJsonBody } from "@/server/http/route-factory";

describe("API route factory", () => {
  it("adds a request ID to successful responses", async () => {
    const response = await apiHandler(
      new Request("http://localhost/api/v1/test", {
        headers: { "x-request-id": "req_12345678" },
      }),
      (context) => json({ ok: true }, 200, context.requestId),
    );
    expect(response.headers.get("x-request-id")).toBe("req_12345678");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("maps thrown API errors to the common envelope", async () => {
    const response = await apiHandler(new Request("http://localhost/api/v1/test"), () => {
      throw new ApiError(403, "FORBIDDEN", "Denied");
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN", requestId: expect.any(String) });
  });

  it("rejects malformed JSON as a bad request", async () => {
    const request = new Request("http://localhost/api/v1/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    await expect(parseJsonBody(request)).rejects.toMatchObject({ status: 400, code: "JSON_INVALID" });
  });
});
