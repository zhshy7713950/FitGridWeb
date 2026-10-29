import { requestJson } from "@/lib/api-client";
import { isUiDemoMode } from "@/lib/ui-demo";
import type { AlertDTO, AlertInput, AlertPage, ChannelStatus, EventPage, Instrument, InstrumentCandidate } from "./types";

const loadDemo = process.env.NODE_ENV === "production" ? null : () => import("./demo-price-alerts");
function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
export const alertApi = {
  list(signal?: AbortSignal): Promise<AlertPage> {
    if (isUiDemoMode() && loadDemo) return loadDemo().then((demo) => demo.demoApi.list());
    return requestJson("/price-alerts", { signal });
  },
  get(id: string, signal?: AbortSignal): Promise<AlertDTO> {
    if (isUiDemoMode() && loadDemo) return loadDemo().then((demo) => demo.demoApi.get(id));
    return requestJson(`/price-alerts/${encodeURIComponent(id)}`, { signal });
  },
  events(id: string, before?: string, signal?: AbortSignal): Promise<EventPage> {
    if (isUiDemoMode() && loadDemo) return loadDemo().then((demo) => demo.demoApi.events(id, before));
    return requestJson(`/price-alerts/${encodeURIComponent(id)}/events${before ? `?${new URLSearchParams({ before })}` : ""}`, { signal });
  },
  search(market: "cn" | "us", query: string): Promise<{ items: InstrumentCandidate[] }> {
    if (isUiDemoMode() && loadDemo) return loadDemo().then((demo) => demo.demoApi.search(market, query));
    return requestJson("/market/instruments/search", json("POST", { market, query }));
  },
  resolve(market: "cn" | "us", code: string): Promise<Instrument> {
    if (isUiDemoMode() && loadDemo) return loadDemo().then((demo) => demo.demoApi.resolve(market, code));
    return requestJson("/market/instruments/resolve", json("POST", { market, code }));
  },
  create(input: AlertInput & { instrumentId: string }): Promise<AlertDTO> {
    if (isUiDemoMode() && loadDemo) return loadDemo().then((demo) => demo.demoApi.create(input));
    return requestJson("/price-alerts", json("POST", input));
  },
  update(id: string, input: Partial<AlertInput> & { expectedVersion: number }): Promise<AlertDTO> {
    if (isUiDemoMode() && loadDemo) return loadDemo().then((demo) => demo.demoApi.update(id, input));
    return requestJson(`/price-alerts/${encodeURIComponent(id)}`, json("PATCH", input));
  },
  remove(id: string, expectedVersion: number): Promise<void> {
    if (isUiDemoMode() && loadDemo) return loadDemo().then((demo) => demo.demoApi.remove(id));
    return requestJson(`/price-alerts/${encodeURIComponent(id)}`, json("DELETE", { expectedVersion }));
  },
  channel(signal?: AbortSignal): Promise<ChannelStatus> {
    if (isUiDemoMode() && loadDemo) return loadDemo().then((demo) => demo.demoApi.channel());
    return requestJson("/settings/notifications", { signal });
  },
  saveChannel(deviceKey: string): Promise<ChannelStatus> {
    if (isUiDemoMode() && loadDemo) return loadDemo().then((demo) => demo.demoApi.saveChannel());
    return requestJson("/settings/notifications", json("PUT", { deviceKey }));
  },
  removeChannel(): Promise<void> {
    if (isUiDemoMode() && loadDemo) return loadDemo().then((demo) => demo.demoApi.removeChannel());
    return requestJson("/settings/notifications", { method: "DELETE" });
  },
  testChannel(): Promise<{ accepted: true }> {
    if (isUiDemoMode() && loadDemo) return loadDemo().then((demo) => demo.demoApi.testChannel());
    return requestJson("/settings/notifications/test", json("POST", {}));
  },
};
