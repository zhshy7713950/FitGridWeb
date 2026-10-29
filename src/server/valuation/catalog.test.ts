import { describe, expect, it } from "vitest";
import { PRODUCTS, resolveValuationProduct } from "./catalog";
describe("valuation product identity", () => {
  it("maps the 24 researched products plus the two historical control ETFs precisely", () => {
    expect(PRODUCTS).toHaveLength(26);
    expect(resolveValuationProduct("510880")?.benchmark?.id).toBe("000015");
    expect(resolveValuationProduct("512890.SS")).toBeNull();
    expect(resolveValuationProduct("512890.SZ")).toBeNull();
    expect(resolveValuationProduct("512890.SH")?.benchmark?.id).toBe("H30269");
    expect(resolveValuationProduct("161130")?.kind).toBe("lof");
    expect(resolveValuationProduct("159638")?.mappingSince).toBe("2026-08-28");
  });
  it("shares index observations without sharing fund prices", () => {
    const a=resolveValuationProduct("voo.us")!, b=resolveValuationProduct("513650")!;
    expect(a.series.pe?.key).toBe(b.series.pe?.key);
    expect(a.series.price?.key).not.toBe(b.series.price?.key);
  });
  it("does not guess benchmarks or treat REIT fundamentals as index valuations", () => {
    for(const code of ["https://evil.invalid", "000015", "传媒", "", "VOO.SH"]) expect(resolveValuationProduct(code)).toBeNull();
    expect(resolveValuationProduct("508000")?.series.pe).toBeNull();
    expect(resolveValuationProduct("508000")?.kind).toBe("reit");
    expect(resolveValuationProduct("SCHD")?.series.pb).toBeNull();
  });
});
