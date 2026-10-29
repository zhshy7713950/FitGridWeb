import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PriceDecimal as Decimal } from "./decimal";
import { Prisma, type PrismaClient, type PriceAlert } from "@/generated/prisma/client";
import { ApiError } from "@/server/http/api-error";
import { evaluateBars, ruleSchema, triggerThreshold } from "./engine";
import { historySum } from "./market-data";
import type { AlertCondition, DailyBasis, Instrument, ScanWindow, SourceResult } from "./types";

export const jsonValue = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const missing = () => new ApiError(404, "ALERT_NOT_FOUND", "预警不存在");
const conflict = () => new ApiError(409, "EDIT_CONFLICT", "预警已更新，请重新载入后再操作");
export async function cancelOutbox(tx: Prisma.TransactionClient, ruleId?: string) {
  await tx.$executeRaw(Prisma.sql`UPDATE price_alert_events e SET evidence = e.evidence || jsonb_build_object('delivery', jsonb_build_object('status', 'cancelled', 'lastError', NULL, 'acceptedAt', NULL, 'attempts', o.attempts)) FROM price_alert_outbox o WHERE e.outbox_id = o.id AND o.status IN ('pending', 'sending') ${ruleId ? Prisma.sql`AND o.rule_id = ${ruleId}::uuid` : Prisma.empty}`);
  await tx.priceAlertOutbox.updateMany({ where: { ...(ruleId ? { ruleId } : {}), status: { in: ["pending", "sending"] } }, data: { status: "cancelled", leaseUntil: null } });
}
export function asInstrument(row: { id: string; code: string; name: string; market: string; currency: string; kind: string; tencent: string | null; yahoo: string | null; eastmoney: string | null }): Instrument {
  return { ...row, market: row.market as Instrument["market"], currency: row.currency as Instrument["currency"], kind: row.kind as Instrument["kind"] };
}
export class AlertRepository {
  constructor(readonly prisma: PrismaClient, readonly clock: () => number = Date.now) {}
  scope<T>(ownerId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_user_id', ${ownerId}, true)`;
      return fn(tx);
    }, { maxWait: 10000, timeout: 15000 });
  }
  private write<T>(ownerId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.scope(ownerId, async (tx) => {
      const users = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM users WHERE id = ${ownerId}::uuid FOR UPDATE`;
      if (users[0]?.status !== "active") throw new ApiError(401, "UNAUTHORIZED", "账号不可用");
      return fn(tx);
    });
  }
  saveInstrument(input: Omit<Instrument, "id">) {
    return this.prisma.marketInstrument.upsert({ where: { code: input.code }, create: input, update: input });
  }
  list(ownerId: string) { return this.scope(ownerId, (tx) => tx.priceAlert.findMany({ where: { deletedAt: null }, include: { instrument: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 250 })); }
  detail(ownerId: string, id: string) { return this.scope(ownerId, (tx) => tx.priceAlert.findUnique({ where: { id }, include: { instrument: true } })); }
  events(ownerId: string, id: string, before?: string) {
    let cursor: { minuteStart: string; id: string } | undefined;
    if (before) {
      try { cursor = z.strictObject({ minuteStart: z.iso.datetime(), id: z.uuid() }).parse(JSON.parse(Buffer.from(before, "base64url").toString("utf8"))); }
      catch { throw new ApiError(400, "CURSOR_INVALID", "提醒记录分页游标无效"); }
    }
    return this.scope(ownerId, async (tx) => {
      if (!await tx.priceAlert.findUnique({ where: { id } })) throw missing();
      const items = await tx.priceAlertEvent.findMany({ where: { ruleId: id, ...(cursor ? { OR: [{ minuteStart: { lt: new Date(cursor.minuteStart) } }, { minuteStart: new Date(cursor.minuteStart), id: { lt: cursor.id } }] } : {}) }, orderBy: [{ minuteStart: "desc" }, { id: "desc" }], take: 50 });
      const outboxes = await tx.priceAlertOutbox.findMany({ where: { id: { in: items.flatMap((e) => e.outboxId ? [e.outboxId] : []) } }, select: { id: true, status: true, lastError: true, acceptedAt: true, attempts: true } });
      return items.map((e) => {
        const evidence = e.evidence && typeof e.evidence === "object" && !Array.isArray(e.evidence) ? e.evidence : {};
        return { ...e, delivery: outboxes.find((o) => o.id === e.outboxId) ?? evidence.delivery ?? { status: "history", lastError: null, acceptedAt: null, attempts: 0 } };
      });
    });
  }
  private async ready(tx: Prisma.TransactionClient, ownerId: string) {
    const channel = await tx.priceAlertChannel.findUnique({ where: { ownerId } });
    if (!channel?.testedAt) throw new ApiError(409, "CHANNEL_NOT_READY", "请先配置 Bark 并成功发送测试通知");
  }
  create(ownerId: string, input: { instrumentId: string; condition: AlertCondition; enabled: boolean }) {
    const condition = ruleSchema.parse(input.condition);
    return this.write(ownerId, async (tx) => {
      if (!await tx.marketInstrument.findUnique({ where: { id: input.instrumentId } })) throw new ApiError(422, "INSTRUMENT_INVALID", "请先核对产品代码");
      if (await tx.priceAlert.count({ where: { deletedAt: null } }) >= 250) throw new ApiError(409, "ALERT_CAPACITY", "每个账号最多保存 250 条预警");
      if (input.enabled) await this.ready(tx, ownerId);
      return tx.priceAlert.create({ data: { ownerId, instrumentId: input.instrumentId, condition: jsonValue(condition), enabled: input.enabled, activeFrom: new Date(Math.ceil(this.clock() / 60000) * 60000) }, include: { instrument: true } });
    });
  }
  update(ownerId: string, id: string, input: { expectedVersion: number; condition?: AlertCondition; enabled?: boolean; deleted?: boolean }) {
    return this.write(ownerId, async (tx) => {
      const current = await tx.priceAlert.findUnique({ where: { id } });
      if (!current || current.deletedAt) throw missing();
      if (current.version !== input.expectedVersion) throw conflict();
      const enabled = input.deleted ? false : input.enabled ?? current.enabled;
      if (enabled) await this.ready(tx, ownerId);
      await cancelOutbox(tx, id);
      return tx.priceAlert.update({ where: { id }, data: { condition: input.condition ? jsonValue(ruleSchema.parse(input.condition)) : undefined, enabled, version: { increment: 1 }, armed: true, cursor: null,
        activeFrom: new Date(Math.ceil(this.clock() / 60000) * 60000), continuityDegraded: false, lastError: null, lastEvaluation: Prisma.DbNull, deletedAt: input.deleted ? new Date(this.clock()) : undefined }, include: { instrument: true } });
    });
  }
  channel(ownerId: string) { return this.scope(ownerId, (tx) => tx.priceAlertChannel.findUnique({ where: { ownerId } })); }
  private async pauseAndCancel(tx: Prisma.TransactionClient) {
    await tx.priceAlert.updateMany({ where: { enabled: true }, data: { enabled: false, version: { increment: 1 } } });
    await cancelOutbox(tx);
  }
  saveChannel(ownerId: string, keyCipher: string) {
    return this.write(ownerId, async (tx) => {
      await this.pauseAndCancel(tx);
      return tx.priceAlertChannel.upsert({ where: { ownerId }, create: { ownerId, keyCipher }, update: { keyCipher, version: { increment: 1 }, testedAt: null, lastError: null } });
    });
  }
  removeChannel(ownerId: string) { return this.write(ownerId, async (tx) => { await this.pauseAndCancel(tx); await tx.priceAlertChannel.deleteMany(); }); }
  markChannelTested(ownerId: string, version: number, error: string | null = null) {
    return this.write(ownerId, async (tx) => {
      const updated = await tx.priceAlertChannel.updateMany({ where: { ownerId, version }, data: { testedAt: error ? null : new Date(this.clock()), lastError: error } });
      if (!updated.count) throw new ApiError(409, "CHANNEL_CHANGED", "通知配置已变更，请重新测试");
    });
  }
  async activeOwners() { return this.prisma.user.findMany({ where: { status: "active" }, select: { id: true } }); }
  activeRules(ownerId: string) { return this.scope(ownerId, (tx) => tx.priceAlert.findMany({ where: { enabled: true, deletedAt: null }, include: { instrument: true }, orderBy: { createdAt: "asc" }, take: 250 })); }
  async basis(instrumentId: string, provider: string, sessionDate: string) {
    const row = await this.prisma.marketDailyBasis.findUnique({ where: { instrumentId_provider_sessionDate: { instrumentId, provider, sessionDate } } });
    return row?.payload as unknown as DailyBasis | null ?? null;
  }
  async saveSource(instrument: Instrument, source: SourceResult, sessionDate: string, quote = true) {
    if (!source.error && source.bars.length) {
      await this.prisma.marketMinute.createMany({ data: source.bars.map((b) => ({ instrumentId: instrument.id, provider: source.provider, start: new Date(b.start), end: new Date(b.end), open: b.open, high: b.high, low: b.low, close: b.close, fetchedAt: new Date(source.fetchedAt) })), skipDuplicates: true });
      if (quote) { const last = source.bars.at(-1)!; await this.prisma.marketInstrument.update({ where: { id: instrument.id }, data: { quote: jsonValue({ price: last.close, minuteStart: new Date(last.start).toISOString(), minuteEnd: new Date(last.end).toISOString(), fetchedAt: source.fetchedAt, provider: source.provider }) } }); }
    }
    if (source.basis) await this.prisma.marketDailyBasis.upsert({ where: { instrumentId_provider_sessionDate: { instrumentId: instrument.id, provider: source.provider, sessionDate } }, create: { instrumentId: instrument.id, provider: source.provider, sessionDate, payload: jsonValue(source.basis) }, update: { payload: jsonValue(source.basis) } });
  }
  recordFailure(rule: PriceAlert, error: string) { return this.scope(rule.ownerId, (tx) => tx.priceAlert.updateMany({ where: { id: rule.id, version: rule.version, enabled: true }, data: { lastError: error.slice(0, 240) } })); }
  commitWindow(rule: PriceAlert, source: SourceResult, window: ScanWindow, batchEnd: number, baseUrl: string, degraded: boolean) {
    return this.write(rule.ownerId, async (tx) => {
      const current = await tx.priceAlert.findUnique({ where: { id: rule.id }, include: { instrument: true } });
      const channel = await tx.priceAlertChannel.findUnique({ where: { ownerId: rule.ownerId } });
      if (!current?.enabled || current.deletedAt || current.version !== rule.version || !channel?.testedAt) return 0;
      const condition = ruleSchema.parse(current.condition);
      const sum = condition.kind === "price" ? undefined : historySum(source.basis!, condition.days);
      const result = evaluateBars(condition, { armed: current.armed, cursor: current.cursor?.getTime() ?? null, activeFrom: current.activeFrom.getTime() }, source.bars, sum);
      const lastBar = source.bars.at(-1)!;
      const evaluation = { price: lastBar.close, provider: source.provider, minuteEnd: new Date(lastBar.end).toISOString(), fetchedAt: source.fetchedAt, ma: condition.kind === "price" ? null : new Decimal(sum!).plus(lastBar.close).div(condition.days).toString(), threshold: triggerThreshold(condition, sum).toString(), adjustment: source.basis?.adjustment ?? null };
      await tx.priceAlert.update({ where: { id: rule.id }, data: { armed: result.state.armed, cursor: result.state.cursor === null ? undefined : new Date(result.state.cursor), lastError: null, lastSuccess: new Date(this.clock()), continuityDegraded: current.continuityDegraded || degraded, lastEvaluation: jsonValue(evaluation) } });
      if (!result.events.length) return 0;
      const batchDate = new Date(batchEnd);
      const existing = await tx.priceAlertOutbox.findUnique({ where: { ruleId_version_batchEnd: { ruleId: rule.id, version: rule.version, batchEnd: batchDate } } });
      const outboxId = existing?.id ?? randomUUID();
      const evidence = { sessionDate: window.sessionDate, sum: sum ?? null, adjustment: source.basis?.adjustment ?? null, basisProvider: source.basis?.provider ?? null, basisFetchedAt: source.basis?.fetchedAt ?? null, fetchedAt: source.fetchedAt, delayed: window.end < batchEnd, continuityDegraded: degraded, condition };
      const inserted = await tx.priceAlertEvent.createMany({ data: result.events.map((event) => ({ id: randomUUID(), ownerId: rule.ownerId, ruleId: rule.id, version: rule.version, minuteStart: new Date(event.minuteStart), minuteEnd: new Date(event.minuteEnd), price: event.price, threshold: event.threshold, ma: event.ma, provider: source.provider, evidence: jsonValue(evidence), outboxId, createdAt: new Date(this.clock()) })), skipDuplicates: true });
      const events = await tx.priceAlertEvent.findMany({ where: { outboxId }, orderBy: { minuteStart: "asc" } });
      const first = events[0]; const last = events.at(-1)!;
      const conditionText = condition.kind === "price" ? `${condition.direction === "up" ? "向上" : "向下"}达到 ${condition.targetPrice} ${current.instrument.currency}`
        : condition.kind === "ma_touch" ? `${condition.direction === "up" ? "向上" : "向下"}达到 ${condition.days} 日均线`
        : `${condition.direction === "up" ? "高于" : "低于"} ${condition.days} 日均线 ${condition.percent}%`;
      const payload = { id: outboxId, title: `${current.instrument.name} · ${current.instrument.code}`, body: `${conditionText}；${events.length} 次触发\n${first.minuteStart.toISOString()} 至 ${last.minuteEnd.toISOString()}\n判定价 ${last.price.toString()} ${current.instrument.currency}；${source.provider}${window.end < batchEnd ? "；延迟补采" : ""}`, url: `${baseUrl}/price-alerts/${rule.id}?event=${first.id}` };
      if (existing) await tx.priceAlertOutbox.update({ where: { id: existing.id }, data: { payload: jsonValue(payload) } });
      else await tx.priceAlertOutbox.create({ data: { id: outboxId, ownerId: rule.ownerId, ruleId: rule.id, version: rule.version, channelVersion: channel.version, batchEnd: batchDate, payload: jsonValue(payload), createdAt: new Date(this.clock()), nextAttemptAt: new Date(this.clock()), expiresAt: new Date(this.clock() + 300000) } });
      return inserted.count;
    });
  }
}
