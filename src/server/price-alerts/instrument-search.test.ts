import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchInstruments } from "./instrument-search";

const liveFetch = globalThis.fetch;
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); }))); });
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
describe("real instrument candidates", () => {
  it("decodes captured domestic code/name results, excludes indices and respects explicit exchange suffixes", async () => {
    const code = await fixture("tencent-search-code.txt"), name = await fixture("tencent-search-name.txt");
    vi.stubGlobal("fetch", async (url: string) => new Response(new URL(url).searchParams.get("q") === "红利" ? name : code));
    expect(await searchInstruments("cn", "510880", {})).toEqual([{ code: "510880.SH", name: "红利ETF华泰柏瑞", market: "cn", currency: "CNY", kind: "etf", exchange: "上海证券交易所" }]);
    const candidates = await searchInstruments("cn", "红利", {});
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.every((item) => item.kind === "etf")).toBe(true);
    expect(candidates.some((item) => item.code === "000015.SH")).toBe(false);
    expect(await searchInstruments("cn", "510880.SZ", {})).toEqual([]);
    expect((await searchInstruments("cn", "510880.SH", {}))[0].code).toBe("510880.SH");
  });
  it("keeps real US equities and ETFs while filtering foreign listings", async () => {
    vi.stubGlobal("fetch", async () => new Response(await fixture("yahoo-search-aapl.json")));
    const rows = await searchInstruments("us", "AAPL", {});
    expect(rows.find((item) => item.code === "AAPL.US")).toMatchObject({ name: "Apple Inc.", exchange: "NASDAQ", kind: "stock" });
    expect(rows.some((item) => item.kind === "etf")).toBe(true);
    expect(rows.some((item) => item.code.includes(".TO"))).toBe(false);
    expect(rows.every((item) => !("id" in item))).toBe(true);
  });
  it("returns an empty candidate list for a valid empty response and rejects executable or unrelated payloads", async () => {
    vi.stubGlobal("fetch", async () => new Response('v_hint=""'));
    expect(await searchInstruments("cn", "不存在", {})).toEqual([]);
    vi.stubGlobal("fetch", async () => new Response('v_hint="";globalThis.searchWasExecuted=true'));
    await expect(searchInstruments("cn", "510880", {})).rejects.toThrow();
    vi.stubGlobal("fetch", async () => Response.json({ result: { passportWeb: [] } }));
    await expect(searchInstruments("cn", "510880", {})).rejects.toThrow();
  });
  it("runs real HTTP transport with preserved query/timeout and rejects upstream failures", async () => {
    const raw = await fixture("tencent-search-code.txt"), requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url!);
      if (req.url!.includes("hang")) return;
      if (req.url!.includes("error")) { res.statusCode = 503; res.end("unavailable"); return; }
      res.end(raw);
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    vi.stubGlobal("fetch", (url: string, options: RequestInit) => { const remote = new URL(url); return liveFetch(`http://127.0.0.1:${address.port}${remote.pathname}${remote.search}`, options); });
    expect((await searchInstruments("cn", "510880", {}))[0].code).toBe("510880.SH");
    expect(new URL(requests[0], "http://local").searchParams.get("q")).toBe("510880");
    await expect(searchInstruments("cn", "error", {})).rejects.toThrow(/503/);
    await expect(searchInstruments("cn", "hang", { timeoutMs: 25 })).rejects.toThrow();
    expect(requests).toHaveLength(3);
  });
});
