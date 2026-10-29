import { describe, expect, it } from "vitest";
import { resolveValuationProduct } from "./catalog";
import { parseSeries, requestFor, fetchSeriesBatch } from "./sources";
const pe=()=>resolveValuationProduct("510880")!.series.pe!;
const price=()=>resolveValuationProduct("510880")!.series.price!;
describe("fixed source ingestion",()=>{
  it("rejects adjusted Tencent prices instead of silently changing method",()=>{
    expect(()=>parseSeries(price(),{code:0,data:{sh510880:{qfqday:[["2026-10-27",1,2]]}}},"2026-10-28")).toThrow();
    expect(parseSeries(price(),{code:0,data:{sh510880:{day:[["2026-10-27",1,"2"],["2026-10-28",1,3]]}}},"2026-10-27")).toEqual([{date:"2026-10-27",value:"2",quality:"valid"}]);
  });
  it("uses rolling PE, isolates closed-day placeholders and keeps negative observations",()=>{
    const rows=[{tradeDate:"20180618",indexCode:"000015",tradingVol:0,peg:0},{tradeDate:"20261027",indexCode:"000015",tradingVol:100,peg:-3}];
    expect(parseSeries(pe(),{code:"200",data:rows},"2026-10-27")).toEqual([{date:"2026-10-27",value:"-3",quality:"non_positive"}]);
    expect(()=>parseSeries(pe(),{code:"200",data:[{...rows[1],indexCode:"000922"}]},"2026-10-27")).toThrow();
  });
  it("keeps weekend monthly labels and only the later label for a duplicated month",()=>{
    const pb=resolveValuationProduct("510880")!.series.pb!;
    expect(parseSeries(pb,{data:[{date:"2026-05-29",addPb:1.2},{date:"2026-05-31",addPb:1.2}]},"2026-06-01")).toEqual([{date:"2026-05-31",value:"1.2",quality:"valid"}]);
    expect(()=>parseSeries(pb,{data:[]},"2026-06-01")).toThrow();
    expect(()=>parseSeries(pb,{data:[{date:"2026-05-01",addPb:1},{date:"2026-05-10",addPb:2},{date:"2026-05-20",addPb:3}]},"2026-06-01")).toThrow();
  });
  it("uses Yahoo raw closes and rejects the wrong fund symbol",()=>{
    const s=resolveValuationProduct("VOO")!.series.price!;
    const body={chart:{result:[{meta:{symbol:"VOO",currency:"USD",dataGranularity:"1d"},timestamp:[1793107800],indicators:{quote:[{close:[620]}],adjclose:[{adjclose:[600]}]}}]}};
    expect(parseSeries(s,body,"2026-10-28")[0].value).toBe("620");
    body.chart.result[0].meta.symbol="SPY";expect(()=>parseSeries(s,body,"2026-10-28")).toThrow();
  });
  it("constructs date-bounded raw-price requests and rejects untrusted series",()=>{
    expect(requestFor(price(),"2026-01-01","2026-10-27").url).toContain(",day,2026-01-01,2026-10-27,640,");
    expect(()=>requestFor({...price(),symbol:"../../evil"},"2026-01-01","2026-10-27")).toThrow();
  });
  it("rejects HTTP errors, HTML, empty data and oversized bodies",async()=>{
    for(const response of [new Response("denied",{status:403}),new Response("<html>error</html>"),new Response("{}"),new Response("{}",{headers:{"content-length":"9000000"}})]) {
      await expect(fetchSeriesBatch({series:pe(),from:"2026-01-01",to:"2026-10-27"},{signal:new AbortController().signal,fetcher:async()=>response})).rejects.toThrow();
    }
  });
});
