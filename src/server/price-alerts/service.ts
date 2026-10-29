import { randomUUID } from "node:crypto";
import { ApiError } from "@/server/http/api-error";
import { calendarWarning, dateInZone, nextScanAt, segments, ZONES } from "./calendar";
import { decryptKey, encryptKey, sendBark } from "./bark";
import { AlertRepository, asInstrument } from "./repository";
import { assertDailyBasis, fetchDailyBasis, resolveInstrument } from "./market-data";
import { searchInstruments } from "./instrument-search";
import { ruleSchema } from "./engine";
import type { Instrument, Market, Provider } from "./types";

export interface AlertConfiguration { encryptionKey: string; baseUrl: string; beforeRequest: () => Promise<void> }
export class PriceAlertService {
  constructor(readonly repository: AlertRepository, readonly config: AlertConfiguration) {}
  private secret() {
    if (!/^[a-f0-9]{64}$/i.test(this.config.encryptionKey)) throw new ApiError(503, "NOTIFICATION_NOT_CONFIGURED", "服务器通知配置未完成，请运行新版安装器");
    return this.config.encryptionKey;
  }
  async search(market: Market, query: string) {
    try { return { items: await searchInstruments(market, query, { beforeRequest: this.config.beforeRequest }) }; }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(503, "INSTRUMENT_SEARCH_UNAVAILABLE", "产品检索暂时不可用，请稍后重试"); }
  }
  async resolve(market: Market, code: string) {
    try { return await this.repository.saveInstrument(await resolveInstrument(market, code, { beforeRequest: this.config.beforeRequest })); }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(422, "INSTRUMENT_UNAVAILABLE", error instanceof Error && /^(请输入|首版|美股|腾讯未|Yahoo 标的)/.test(error.message) ? error.message : "无法核对产品，请检查代码或稍后重试"); }
  }
  private async requireHistory(product: Instrument, days: number) {
    const now = this.repository.clock();
    const next = nextScanAt(product.market, now);
    if (next === null) throw new ApiError(503, "HISTORY_UNAVAILABLE", "交易日历尚未覆盖，暂时无法验证均线历史");
    const sessionDate = dateInZone(next, ZONES[product.market]);
    const currentDate = dateInZone(now, ZONES[product.market]);
    const inSession = sessionDate === currentDate && segments(product.market, currentDate).some((s) => now >= s.start && now < s.end);
    const providers: Provider[] = [product.market === "cn" ? "tencent" : "yahoo"];
    if (product.eastmoney) providers.push("eastmoney");
    let maximum = 0;
    let unavailable = false;
    for (const provider of providers) {
      let basis = inSession ? await this.repository.basis(product.id, provider, sessionDate) : null;
      if (basis) { try { assertDailyBasis(basis, product.market, sessionDate, provider); } catch { basis = null; } }
      if (!basis || basis.closes.length < days - 1) {
        try { basis = await fetchDailyBasis(provider, product, sessionDate, { beforeRequest: this.config.beforeRequest }); }
        catch { unavailable = true; continue; }
        if (inSession) await this.repository.saveSource(product, { provider, bars: [], basis, fetchedAt: basis.fetchedAt, error: null, durationMs: 0 }, sessionDate, false);
      }
      maximum = Math.max(maximum, basis.closes.length);
      if (basis.closes.length >= days - 1) return;
    }
    if (unavailable) throw new ApiError(503, "HISTORY_UNAVAILABLE", "行情源暂时无法完整验证均线历史，请稍后重试");
    throw new ApiError(422, "HISTORY_INSUFFICIENT", `当前只有 ${maximum} 个历史交易日的数据，最多支持 ${Math.min(500, maximum + 1)} 日动态均线，不能设置 ${days} 日`);
  }
  async create(ownerId: string, input: Parameters<AlertRepository["create"]>[1]) {
    const condition = ruleSchema.parse(input.condition);
    if (condition.kind !== "price") {
      const product = await this.repository.prisma.marketInstrument.findUnique({ where: { id: input.instrumentId } });
      if (!product) throw new ApiError(422, "INSTRUMENT_INVALID", "请先核对产品代码");
      await this.requireHistory(asInstrument(product), condition.days);
    }
    return this.repository.create(ownerId, { ...input, condition });
  }
  async update(ownerId: string, id: string, input: Parameters<AlertRepository["update"]>[2]) {
    const rule = await this.repository.detail(ownerId, id);
    if (!rule || rule.deletedAt) throw new ApiError(404, "ALERT_NOT_FOUND", "预警不存在");
    if (rule.version !== input.expectedVersion) throw new ApiError(409, "EDIT_CONFLICT", "预警已更新，请重新载入后再操作");
    const condition = ruleSchema.parse(input.condition ?? rule.condition);
    if (!input.deleted && (input.condition !== undefined || input.enabled === true) && condition.kind !== "price") {
      await this.requireHistory(asInstrument(rule.instrument), condition.days);
    }
    return this.repository.update(ownerId, id, input);
  }
  async list(ownerId: string) {
    const now = new Date(this.repository.clock());
    const items = await this.repository.list(ownerId);
    const warnings = [calendarWarning("cn", now), calendarWarning("us", now)].filter((v): v is string => Boolean(v));
    const lastScan = await this.repository.prisma.marketScan.findFirst({ where: { market: { in: [...new Set(items.map((r) => r.instrument.market))] } }, orderBy: { createdAt: "desc" }, select: { market: true, status: true, windowEnd: true, finishedAt: true } });
    const next = [...new Set(items.filter((r) => r.enabled).map((r) => r.instrument.market as Market))]
      .map((market) => nextScanAt(market, now.getTime())).filter((time): time is number => time !== null);
    return { items: items.map(publicRule), status: { calendarWarnings: warnings, nextRunAt: next.length ? new Date(Math.min(...next)).toISOString() : null, lastScan } };
  }
  async detail(ownerId: string, id: string) {
    const rule = await this.repository.detail(ownerId, id);
    if (!rule) throw new ApiError(404, "ALERT_NOT_FOUND", "预警不存在");
    return publicRule(rule);
  }
  async events(ownerId: string, id: string, before?: string) {
    const rows = await this.repository.events(ownerId, id, before);
    const last = rows.at(-1);
    const items = rows.map((event) => {
      const { ownerId, outboxId, delivery, ...visible } = event;
      void ownerId; void outboxId;
      const state = delivery && typeof delivery === "object" && !Array.isArray(delivery) ? delivery as Record<string, unknown> : {};
      return { ...visible, price: event.price.toString(), threshold: event.threshold.toString(), ma: event.ma?.toString() ?? null,
        delivery: { status: typeof state.status === "string" ? state.status : "history", lastError: typeof state.lastError === "string" ? state.lastError : null,
          acceptedAt: state.acceptedAt instanceof Date ? state.acceptedAt.toISOString() : typeof state.acceptedAt === "string" ? state.acceptedAt : null,
          attempts: typeof state.attempts === "number" ? state.attempts : 0 } };
    });
    return { items, nextCursor: rows.length === 50 && last ? Buffer.from(JSON.stringify({ minuteStart: last.minuteStart.toISOString(), id: last.id })).toString("base64url") : null };
  }
  async channelStatus(ownerId: string) {
    const channel = await this.repository.channel(ownerId);
    return { configured: Boolean(channel), tested: Boolean(channel?.testedAt), testedAt: channel?.testedAt?.toISOString() ?? null, lastError: channel?.lastError ?? null, encryptionReady: /^[a-f0-9]{64}$/i.test(this.config.encryptionKey) };
  }
  async saveChannel(ownerId: string, key: string) { await this.repository.saveChannel(ownerId, encryptKey(key, this.secret())); return this.channelStatus(ownerId); }
  async testChannel(ownerId: string) {
    const channel = await this.repository.channel(ownerId);
    if (!channel) throw new ApiError(409, "CHANNEL_NOT_READY", "请先保存 Bark 设备 Key");
    let key: string;
    try { key = decryptKey(channel.keyCipher, this.secret()); } catch { throw new ApiError(503, "CHANNEL_UNREADABLE", "无法解密通知配置，请重新填写设备 Key"); }
    const result = await sendBark(key, { id: randomUUID(), title: "FitGrid 通知测试", body: "Bark 通道测试；请在 iPhone 确认收到。", url: `${this.config.baseUrl}/settings/notifications` }, { beforeRequest: this.config.beforeRequest });
    await this.repository.markChannelTested(ownerId, channel.version, result.error);
    if (!result.accepted) throw new ApiError(503, "BARK_REJECTED", result.error ?? "Bark 测试失败");
    return { accepted: true };
  }
}

export function publicRule<T extends { ownerId: string; condition: unknown }>(rule: T) {
  const { ownerId: _ownerId, ...result } = rule;
  void _ownerId;
  return result;
}
