// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClientApiError } from "@/lib/api-client";
import type { AlertDTO, ChannelStatus } from "./types";
const { push, api } = vi.hoisted(() => ({ push: vi.fn(), api: { list: vi.fn(), get: vi.fn(), update: vi.fn(), remove: vi.fn(), events: vi.fn(), search: vi.fn(), resolve: vi.fn(), create: vi.fn(), channel: vi.fn(), saveChannel: vi.fn(), testChannel: vi.fn(), removeChannel: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("./price-alert-api", () => ({ alertApi: api }));
import { AlertListPage, AlertDetailPage, AlertEditorPage, NotificationSettingsPage } from "./price-alert-pages";
const rule: AlertDTO = {
  id: "rule-1", instrument: { id: "inst-1", name: "黄金 ETF", code: "518880", market: "cn", currency: "CNY", kind: "etf", tencent: "sh518880", yahoo: "518880.SS", eastmoney: "1.518880", quote: { price: "6.92", provider: "tencent", minuteStart: "2026-10-27T03:00:00Z", minuteEnd: "2026-10-27T03:01:00Z", fetchedAt: "2026-10-27T03:01:15Z" } },
  condition: { kind: "price", direction: "up", targetPrice: "6.92" }, enabled: true, version: 4, armed: true,
  activeFrom: "2026-10-27T03:02:00Z", cursor: null, continuityDegraded: false, lastError: null, lastSuccess: null, deletedAt: null, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", lastEvaluation: null,
};
const channel: ChannelStatus = { configured: true, tested: true, testedAt: "2026-10-27T00:00:00Z", lastError: null, encryptionReady: true };
beforeEach(() => {
  vi.resetAllMocks();
  api.list.mockResolvedValue({ items: [rule], status: { calendarWarnings: [], nextRunAt: null, lastScan: null } });
  api.search.mockResolvedValue({ items: [{ code: "518880.SH", name: "黄金 ETF", market: "cn", currency: "CNY", kind: "etf", exchange: "上海证券交易所" }] });
  api.get.mockResolvedValue(rule); api.events.mockResolvedValue({ items: [], nextCursor: null }); api.channel.mockResolvedValue(channel);
});
afterEach(cleanup);
it("searches real candidate names and requires an explicit selection before showing alert conditions", async () => {
  const user = userEvent.setup();
  const candidate = { code: "510880.SH", name: "红利ETF华泰柏瑞", market: "cn", currency: "CNY", kind: "etf", exchange: "上海证券交易所" };
  api.search.mockResolvedValue({ items: [candidate] });
  api.resolve.mockResolvedValue({ ...rule.instrument, code: candidate.code, name: candidate.name });
  render(<AlertEditorPage />);
  await user.type(screen.getByLabelText("产品代码或名称"), "红利");
  await user.click(screen.getByRole("button", { name: "搜索产品" }));
  expect(await screen.findByText("红利ETF华泰柏瑞")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "保存提醒" })).not.toBeInTheDocument();
  expect(api.resolve).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: /确认选择.*510880.SH/ }));
  expect(await screen.findByRole("button", { name: "保存提醒" })).toBeInTheDocument();
  expect(api.search).toHaveBeenCalledWith("cn", "红利");
  expect(api.resolve).toHaveBeenCalledWith("cn", "510880.SH");
  await user.type(screen.getByLabelText("产品代码或名称"), "1");
  expect(screen.queryByRole("button", { name: "保存提醒" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /确认选择/ })).not.toBeInTheDocument();
});

it("links to details and sends the displayed version when pausing", async () => {
  const user = userEvent.setup(); api.update.mockResolvedValue({ ...rule, enabled: false, version: 5 });
  render(<AlertListPage />);
  expect(await screen.findByRole("link", { name: "黄金 ETF" })).toHaveAttribute("href", "/price-alerts/rule-1");
  await user.click(screen.getByRole("button", { name: "暂停" }));
  expect(api.update).toHaveBeenCalledWith("rule-1", { expectedVersion: 4, enabled: false });
  expect(await screen.findByRole("button", { name: "恢复" })).toBeInTheDocument();
});
it("offers reload on edit conflict instead of silently overwriting", async () => {
  const user = userEvent.setup(); api.update.mockRejectedValue(new ClientApiError(409, "EDIT_CONFLICT", "冲突"));
  render(<AlertListPage />); await screen.findByRole("link", { name: "黄金 ETF" });
  await user.click(screen.getByRole("button", { name: "暂停" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("已在其他页面更新");
  await user.click(screen.getByRole("button", { name: "重新载入" }));
  expect(api.list).toHaveBeenCalledTimes(2);
});
it("shows cached quote source and delivery failures without resolving instruments", async () => {
  api.events.mockResolvedValue({ items: [{ id: "evt-1", minuteStart: "2026-10-27T03:00:00Z", minuteEnd: "2026-10-27T03:01:00Z", price: "6.92", threshold: "6.92", ma: null, provider: "tencent", evidence: { delayed: true }, delivery: { status: "failed", lastError: "设备不可用", acceptedAt: null, attempts: 2 } }], nextCursor: null });
  render(<AlertDetailPage id="rule-1" />);
  expect(await screen.findByText("设备不可用")).toBeInTheDocument();
  expect(screen.getAllByText("腾讯财经").length).toBeGreaterThan(0);
  expect(screen.getByText("延迟补发")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "编辑提醒" })).toHaveAttribute("href", "/price-alerts/rule-1/edit");
  expect(api.resolve).not.toHaveBeenCalled();
});
it("requires a fresh instrument confirmation when the new-rule code changes", async () => {
  const user = userEvent.setup(); api.resolve.mockResolvedValue(rule.instrument);
  render(<AlertEditorPage prefill={{ code: "518880", market: "cn" }} />);
  await user.click(screen.getByRole("button", { name: "搜索产品" }));
  await user.click(await screen.findByRole("button", { name: /确认选择/ }));
  await screen.findByText("黄金 ETF");
  await user.type(screen.getByLabelText("产品代码或名称"), "1");
  expect(screen.queryByRole("button", { name: "保存提醒" })).not.toBeInTheDocument();
});
it("offers domestic code or name entry without requiring an exchange suffix", () => {
  render(<AlertEditorPage />);
  expect(screen.getByPlaceholderText("例如 510880 或 红利")).toBeInTheDocument();
});
it("clears the secret after replacing the channel and explains paused alerts", async () => {
  const user = userEvent.setup(); api.saveChannel.mockResolvedValue({ ...channel, tested: false });
  render(<NotificationSettingsPage />); await screen.findByText("已配置");
  expect(screen.getByText(/替换或移除.*暂停全部提醒/)).toBeInTheDocument();
  const input = screen.getByLabelText("Bark 设备 Key");
  expect(input).toHaveAttribute("type", "password"); expect(input).toHaveValue("");
  await user.type(input, "secret-key");
  await user.click(screen.getByLabelText("我知道此操作会暂停全部提醒"));
  await user.click(screen.getByRole("button", { name: "保存设备 Key" }));
  expect(api.saveChannel).toHaveBeenCalledWith("secret-key");
  expect(input).toHaveValue(""); expect(document.body).not.toHaveTextContent("secret-key");
  expect(await screen.findByText("尚未测试")).toBeInTheDocument();
});
it("keeps deleted details read-only and confirms deletion before removing a list item", async () => {
  api.get.mockResolvedValue({ ...rule, deletedAt: "2026-10-27T05:00:00Z" });
  const user = userEvent.setup();
  const view = render(<AlertDetailPage id="rule-1" />); await screen.findByText("已删除");
  expect(screen.queryByRole("link", { name: "编辑提醒" })).not.toBeInTheDocument(); view.unmount();
  api.remove.mockResolvedValue(undefined); render(<AlertListPage />); await screen.findByRole("link", { name: "黄金 ETF" });
  await user.click(screen.getByRole("button", { name: "删除" })); expect(api.remove).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole("group", { name: "删除确认" })).getByRole("button", { name: "确认删除" }));
  expect(api.remove).toHaveBeenCalledWith("rule-1", 4);
});
it("resumes with the latest version and exposes channel-not-ready errors", async () => {
  const user = userEvent.setup();
  api.list.mockResolvedValue({ items: [{ ...rule, enabled: false, version: 8 }], status: { calendarWarnings: [], nextRunAt: null } });
  api.update.mockRejectedValue(new ClientApiError(409, "CHANNEL_NOT_READY", "请先保存并测试通知设备"));
  render(<AlertListPage />); await screen.findByRole("button", { name: "恢复" });
  await user.click(screen.getByRole("button", { name: "恢复" }));
  expect(api.update).toHaveBeenCalledWith("rule-1", { expectedVersion: 8, enabled: true });
  expect(await screen.findByRole("alert")).toHaveTextContent("请先保存并测试通知设备");
  expect(screen.getByRole("link", { name: "通知设置" })).toHaveAttribute("href", "/settings/notifications");
});
it("edits the displayed rule condition and version before navigating to detail", async () => {
  const user = userEvent.setup(); api.update.mockResolvedValue({ ...rule, version: 5 });
  render(<AlertEditorPage id="rule-1" />); await screen.findByLabelText("目标价格");
  await user.selectOptions(screen.getByLabelText("触发方向"), "down");
  await user.click(screen.getByRole("button", { name: "保存提醒" }));
  expect(api.update).toHaveBeenCalledWith("rule-1", { expectedVersion: 4, condition: { kind: "price", direction: "down", targetPrice: "6.92" }, enabled: true });
  expect(push).toHaveBeenCalledWith("/price-alerts/rule-1");
});
it("tests the channel and requires acknowledgement before removal", async () => {
  const user = userEvent.setup(); api.testChannel.mockResolvedValue({ accepted: true }); api.removeChannel.mockResolvedValue(undefined);
  render(<NotificationSettingsPage />); await screen.findByText("已配置");
  expect(screen.getByRole("button", { name: "移除设备" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "发送测试通知" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Bark 已接收测试通知");
  await user.click(screen.getByLabelText("我知道此操作会暂停全部提醒"));
  await user.click(screen.getByRole("button", { name: "移除设备" }));
  expect(api.removeChannel).toHaveBeenCalledOnce();
  expect(await screen.findByText("未配置")).toBeInTheDocument();
});
it("shows cached minute close, currency, source and quote time on each list card", async () => {
  const usd = { ...rule, id: "us-rule", instrument: { ...rule.instrument, name: "Apple", code: "AAPL.US", market: "us" as const, currency: "USD" as const, quote: { ...rule.instrument.quote!, price: "236.48", provider: "yahoo" } } };
  api.list.mockResolvedValue({ items: [rule, usd], status: { calendarWarnings: [], nextRunAt: null } });
  render(<AlertListPage />); await screen.findByRole("link", { name: "黄金 ETF" });
  const cnCard = screen.getByRole("link", { name: "黄金 ETF" }).closest("article")!;
  expect(within(cnCard).getByText("缓存分钟收盘价")).toBeInTheDocument();
  expect(within(cnCard).getByText("CNY 6.920")).toBeInTheDocument();
  expect(within(cnCard).getByText("腾讯财经")).toBeInTheDocument();
  expect(within(cnCard).getByText(/来源：/)).toBeInTheDocument();
  expect(within(cnCard).getByText(/行情时间：/)).toBeInTheDocument();
  expect(within(cnCard).getByText(new Date(rule.instrument.quote!.minuteEnd).toLocaleString("zh-CN", { hour12: false }))).toBeInTheDocument();
  expect(within(screen.getByRole("link", { name: "Apple" }).closest("article")!).getByText("USD 236.48")).toBeInTheDocument();
});
it("marks an enabled disarmed rule as waiting outside the condition", async () => {
  api.list.mockResolvedValue({ items: [{ ...rule, armed: false }], status: { calendarWarnings: [], nextRunAt: null } });
  render(<AlertListPage />);
  expect(await screen.findByText("已提醒，等待离开条件")).toBeInTheDocument();
  expect(screen.queryByText("观察中")).not.toBeInTheDocument();
});
it("shows a market-data error state and preserves its specific cause", async () => {
  api.get.mockResolvedValue({ ...rule, lastError: "日线覆盖不足，缺少 5 天" });
  render(<AlertDetailPage id="rule-1" />);
  expect(await screen.findByText("行情异常")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("日线覆盖不足，缺少 5 天");
});
it("keeps the main price, source and times together with the MA evaluation snapshot", async () => {
  const evaluation = { price: "6.80", provider: "eastmoney", minuteEnd: "2026-10-27T02:50:00Z", fetchedAt: "2026-10-27T02:50:15Z", ma: "6.85", threshold: "6.85", adjustment: "前复权 qfq" };
  api.get.mockResolvedValue({ ...rule, condition: { kind: "ma_touch", direction: "down", days: 20 }, lastEvaluation: evaluation, instrument: { ...rule.instrument, quote: { ...rule.instrument.quote!, price: "99.99", provider: "yahoo" } } });
  render(<AlertDetailPage id="rule-1" />);
  const snapshot = await screen.findByRole("region", { name: "行情快照" });
  expect(within(snapshot).getByText("6.800")).toBeInTheDocument();
  expect(within(snapshot).getByText("最近有效判断的分钟收盘价")).toBeInTheDocument();
  expect(within(snapshot).getByText("东方财富")).toBeInTheDocument();
  expect(within(snapshot).getByText("6.850")).toBeInTheDocument();
  expect(within(snapshot).getByLabelText("触发价格")).toHaveTextContent("触发价 ¥6.850");
  expect(within(snapshot).getByText(new Date(evaluation.minuteEnd).toLocaleString("zh-CN", { hour12: false }))).toBeInTheDocument();
  expect(within(snapshot).getByText(new Date(evaluation.fetchedAt).toLocaleString("zh-CN", { hour12: false }))).toBeInTheDocument();
  expect(within(snapshot).queryByText("99.99")).not.toBeInTheDocument();
  expect(within(snapshot).queryByText("Yahoo Finance")).not.toBeInTheDocument();
  expect(within(snapshot).getByText(/最近判断：.*前复权 qfq/)).toBeInTheDocument();
});
it("labels the shared quote as cached and MA not ready when no evaluation exists", async () => {
  api.get.mockResolvedValue({ ...rule, condition: { kind: "ma_touch", direction: "up", days: 20 } });
  render(<AlertDetailPage id="rule-1" />);
  expect(await screen.findByText("缓存分钟收盘价")).toBeInTheDocument();
  expect(screen.getByText("均线尚未就绪，等待有效判断")).toBeInTheDocument();
});
it("pauses and resumes directly from detail using each returned version", async () => {
  const user = userEvent.setup();
  api.update.mockResolvedValueOnce({ ...rule, enabled: false, version: 5 }).mockResolvedValueOnce({ ...rule, enabled: true, armed: true, version: 6 });
  render(<AlertDetailPage id="rule-1" />);
  await user.click(await screen.findByRole("button", { name: "暂停" }));
  expect(api.update).toHaveBeenNthCalledWith(1, "rule-1", { expectedVersion: 4, enabled: false });
  await user.click(await screen.findByRole("button", { name: "恢复" }));
  expect(api.update).toHaveBeenNthCalledWith(2, "rule-1", { expectedVersion: 5, enabled: true });
  expect(await screen.findByText("观察中")).toBeInTheDocument();
});
it("prevents repeated detail mutations while pending", async () => {
  const user = userEvent.setup();
  api.update.mockReturnValue(new Promise(() => {}));
  render(<AlertDetailPage id="rule-1" />);
  await user.click(await screen.findByRole("button", { name: "暂停" }));
  const pending = screen.getByRole("button", { name: "正在暂停…" });
  expect(pending).toBeDisabled(); expect(pending).toHaveAttribute("aria-busy", "true");
  await user.click(pending);
  expect(api.update).toHaveBeenCalledOnce();
});
it("offers a detail reload after a version conflict and leaves the rule unchanged", async () => {
  const user = userEvent.setup(); api.update.mockRejectedValue(new ClientApiError(409, "EDIT_CONFLICT", "冲突"));
  render(<AlertDetailPage id="rule-1" />);
  await user.click(await screen.findByRole("button", { name: "暂停" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("已在其他页面更新");
  expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "重新载入" }));
  expect(api.get).toHaveBeenCalledTimes(2);
});
it("never offers pause or resume on a deleted detail", async () => {
  api.get.mockResolvedValue({ ...rule, deletedAt: "2026-10-27T05:00:00Z" });
  render(<AlertDetailPage id="rule-1" />); await screen.findByText("已删除");
  expect(screen.queryByRole("button", { name: /暂停|恢复/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "编辑提醒" })).not.toBeInTheDocument();
});

it("ignores late search results after the query changes", async () => {
  let finish!: (value: unknown) => void;
  api.search.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const user = userEvent.setup(); render(<AlertEditorPage prefill={{ code: "510880" }} />);
  await user.click(screen.getByRole("button", { name: "搜索产品" }));
  await user.type(screen.getByLabelText("产品代码或名称"), "1");
  await act(async () => { finish({ items: [{ code: "510880.SH", name: "迟到的产品", market: "cn", currency: "CNY", kind: "etf", exchange: "上海证券交易所" }] }); });
  expect(screen.queryByText("迟到的产品")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /确认选择/ })).not.toBeInTheDocument();
});
it("shows real empty and failed searches without offering an unverified product", async () => {
  const user = userEvent.setup(); api.search.mockResolvedValueOnce({ items: [] }).mockRejectedValueOnce(new ClientApiError(503, "INSTRUMENT_SEARCH_UNAVAILABLE", "产品检索暂时不可用"));
  render(<AlertEditorPage prefill={{ code: "510880" }} />);
  await user.click(screen.getByRole("button", { name: "搜索产品" }));
  expect(await screen.findByRole("status")).toHaveTextContent("没有找到支持的股票或 ETF");
  await user.click(screen.getByRole("button", { name: "搜索产品" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("产品检索暂时不可用");
  expect(api.resolve).not.toHaveBeenCalled();
});

it("rounds cached Yahoo prices in both list and detail", async () => {
  const usd = { ...rule, instrument: { ...rule.instrument, market: "us" as const, currency: "USD" as const, quote: { ...rule.instrument.quote!, price: "35.13999938964844", provider: "yahoo" } } };
  api.list.mockResolvedValue({ items: [usd], status: { calendarWarnings: [], nextRunAt: null } });
  api.get.mockResolvedValue(usd);
  const view = render(<AlertListPage />);
  expect(await screen.findByText("USD 35.14")).toBeInTheDocument();
  view.unmount();
  render(<AlertDetailPage id="rule-1" />);
  const snapshot = await screen.findByRole("region", { name: "行情快照" });
  expect(within(snapshot).getByText("股票价格（分钟收盘价）").parentElement).toHaveTextContent("35.14");
  expect(snapshot).not.toHaveTextContent("35.13999938964844");
});
it("clearly identifies the calculated MA price and formats historical trigger values", async () => {
  api.get.mockResolvedValue({ ...rule, instrument: { ...rule.instrument, market: "us", currency: "USD" }, condition: { kind: "ma_touch", direction: "down", days: 120 }, lastEvaluation: { price: "35.13999938964844", provider: "yahoo", minuteEnd: "2026-10-27T03:01:00Z", fetchedAt: "2026-10-27T03:01:15Z", ma: "33.015343221", threshold: "32.9986855964", adjustment: null } });
  api.events.mockResolvedValue({ items: [{ id: "evt-1", minuteStart: "2026-10-27T03:00:00Z", minuteEnd: "2026-10-27T03:01:00Z", price: "34.9976005554", threshold: "32.9986855964", ma: "33.015343221", provider: "yahoo", evidence: { condition: { kind: "ma_touch", direction: "up", days: 20 } }, delivery: { status: "accepted", lastError: null, acceptedAt: null, attempts: 1 } }], nextCursor: null });
  render(<AlertDetailPage id="rule-1" />);
  const snapshot = await screen.findByRole("region", { name: "行情快照" });
  expect(within(snapshot).getByText("MA120 均线价格（计算值）").parentElement).toHaveTextContent("33.02");
  expect(within(snapshot).getByLabelText("触发价格")).toHaveTextContent("触发价 $33.00");
  expect(screen.getByText(/触发时股价 35.00 · 触发边界价格 33.00 · 触发时均线价格（MA20）33.02/)).toBeInTheDocument();
});
it("explicitly marks an unavailable MA calculation instead of showing an unexplained dash", async () => {
  api.get.mockResolvedValue({ ...rule, condition: { kind: "ma_touch", direction: "down", days: 120 } });
  render(<AlertDetailPage id="rule-1" />);
  const snapshot = await screen.findByRole("region", { name: "行情快照" });
  expect(within(snapshot).getByText("MA120 均线价格（计算值）").parentElement).toHaveTextContent("尚未计算");
});

it.each(["up", "down"] as const)("shows the server trigger boundary beside a %s MA deviation without recomputing the rounded MA", async (direction) => {
  api.get.mockResolvedValue({ ...rule, condition: { kind: "ma_deviation", direction, days: 200, percent: "30" }, lastEvaluation: { price: "0.862", ma: "1.019", threshold: direction === "up" ? "1.3256358" : "0.712409", provider: "tencent", minuteEnd: "2026-10-29T03:01:00Z", fetchedAt: "2026-10-29T03:01:15Z", adjustment: "前复权 qfq" } });
  render(<AlertDetailPage id="rule-1" />);
  const condition = await screen.findByRole("group", { name: "提醒条件" });
  expect(condition).toHaveTextContent(`${direction === "up" ? "高于" : "低于"} MA200 30%`);
  expect(within(condition).getByLabelText("触发价格")).toHaveTextContent(direction === "up" ? "触发价 ¥1.326" : "触发价 ¥0.712");
  expect(screen.queryByText("触发边界价格", { exact: true })).not.toBeInTheDocument();
});
it("shows the configured fixed target before the first evaluation", async () => {
  render(<AlertDetailPage id="rule-1" />);
  expect(await screen.findByLabelText("触发价格")).toHaveTextContent("触发价 ¥6.920");
});
it("keeps an unavailable MA threshold pending rather than estimating from a quote", async () => {
  api.get.mockResolvedValue({ ...rule, condition: { kind: "ma_touch", direction: "up", days: 200 } });
  render(<AlertDetailPage id="rule-1" />);
  expect(await screen.findByLabelText("触发价格")).toHaveTextContent("触发价 待计算");
});
it("formats a dollar-denominated trigger with the instrument precision", async () => {
  api.get.mockResolvedValue({ ...rule, instrument: { ...rule.instrument, market: "us", currency: "USD", kind: "stock" }, condition: { kind: "price", direction: "down", targetPrice: "123.456" } });
  render(<AlertDetailPage id="rule-1" />);
  expect(await screen.findByLabelText("触发价格")).toHaveTextContent("触发价 $123.46");
});
