import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { decryptKey, encryptKey, sendBark } from "./bark";
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { await Promise.all(servers.map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }))); servers.length = 0; });
const secret = "ab".repeat(32);
describe("Bark channel security and business responses", () => {
  it("encrypts each key with a fresh authenticated nonce and rejects tampering or the wrong secret", () => {
    const a = encryptKey("private-device-key", secret); const b = encryptKey("private-device-key", secret);
    expect(a).not.toContain("private-device-key"); expect(a).not.toBe(b);
    expect(decryptKey(a, secret)).toBe("private-device-key");
    expect(() => decryptKey(a, "cd".repeat(32))).toThrow();
    expect(() => decryptKey(a.slice(0, -3) + "xxx", secret)).toThrow();
  });
  it("sends key in JSON, stable id and detail URL; HTTP200 alone cannot pass a refusal", async () => {
    const requests: unknown[] = [];
    const server = createServer(async (req, res) => {
      let text = ""; for await (const chunk of req) text += chunk;
      requests.push(JSON.parse(text));
      if (req.url === "/slow") return;
      res.setHeader("content-type", "application/json");
      if (req.url === "/limit") { res.statusCode = 429; res.setHeader("retry-after", "60"); res.end('{"code":429}'); }
      else if (req.url === "/created") { res.statusCode = 201; res.end('{"code":200}'); }
      else res.end(req.url === "/ok" ? '{"code":200,"message":"success"}' : '{"code":400,"message":"private-device-key invalid"}');
    });
    servers.push(server); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address(); if (!a || typeof a === "string") throw new Error("server");
    const base = `http://127.0.0.1:${a.port}`;
    const payload = { id: "event-1", title: "SPY", body: "触发条件", url: "https://example.com/fitgrid/price-alerts/1" };
    expect((await sendBark("private-device-key", payload, { url: `${base}/ok` })).accepted).toBe(true);
    expect((await sendBark("private-device-key", payload, { url: `${base}/created` })).accepted).toBe(false);
    expect(requests[0]).toMatchObject({ ...payload, device_key: "private-device-key" });
    const denied = await sendBark("private-device-key", payload, { url: `${base}/denied` });
    expect(denied).toMatchObject({ accepted: false, permanent: true }); expect(JSON.stringify(denied)).not.toContain("private-device-key");
    expect(await sendBark("key", payload, { url: `${base}/limit` })).toMatchObject({ accepted: false, permanent: false, retryAfterSeconds: 60 });
    expect(await sendBark("key", payload, { url: `${base}/slow`, timeoutMs: 30 })).toMatchObject({ accepted: false, permanent: false, ambiguous: true });
  });
});
