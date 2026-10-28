import type { PriceAlert, Prisma } from "@/generated/prisma/client";
import { decryptKey, sendBark, type BarkResult } from "./bark";
import { calendarWarning, dateInZone, dueWindows, segments, ZONES } from "./calendar";
import { ruleSchema } from "./engine";
import { assertDailyBasis, fetchJson, fetchSource, historySum, parseDaily, selectSources, sourceUrl } from "./market-data";
import { AlertRepository, asInstrument, cancelOutbox, jsonValue } from "./repository";
import type { AlertConfiguration } from "./service";
import type { Market, Provider, ScanWindow, SourceResult } from "./types";

export function canFetchWindow(window: ScanWindow, now: number) {
  return now >= window.segmentStart && now < window.deadline && (now < window.segmentEnd || window.kind === "closing" && now < window.segmentEnd + 60000);
}
export function backfillWindows(window: ScanWindow, wanted: number) {
  const requested = window.segmentStart + Math.floor((Math.max(window.segmentStart, wanted) - window.segmentStart) / 600000) * 600000;
  const start = Math.max(window.segmentStart, window.end - 1800000, Math.min(requested, window.start));
  const windows: ScanWindow[] = [];
  for (let from = start; from < window.end; from += 600000) windows.push({ ...window, start: from, end: from + 600000 });
  return { windows, degraded: requested < start };
}
export function hasContinuityGap(market: Market, from: number, to: number): boolean {
  if (from >= to) return false;
  const first = Date.parse(`${dateInZone(from, ZONES[market])}T12:00:00Z`);
  const last = Date.parse(`${dateInZone(to, ZONES[market])}T12:00:00Z`);
  if (last - first > 32 * 86400000) return true;
  for (let day = first; day <= last; day += 86400000) {
    let sessions: ReturnType<typeof segments>;
    try { sessions = segments(market, new Date(day).toISOString().slice(0, 10)); } catch { return true; }
    if (sessions.some((session) => Math.ceil(Math.max(from, session.start) / 60000) * 60000 + 60000 <= Math.min(to, session.end))) return true;
  }
  return false;
}
export function nextDelivery(row: { attempts: number; createdAt: number; expiresAt: number }, now: number, result: BarkResult): { status: string; nextAttemptAt: number } {
  if (result.accepted) return { status: "accepted", nextAttemptAt: now };
  if (result.permanent || row.attempts >= 3) return { status: "failed", nextAttemptAt: now };
  const next = Math.max(now + Math.max(0, result.retryAfterSeconds ?? 0) * 1000, row.createdAt + (row.attempts === 1 ? 30000 : 120000));
  return next >= row.expiresAt ? { status: "expired", nextAttemptAt: now } : { status: "pending", nextAttemptAt: next };
}
export async function mapLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0; let failed = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed) {
      const index = next++; if (index >= items.length) return;
      try { await run(items[index]); } catch (error) { failed = true; throw error; }
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
class SourceLimiter {
  private total = 0;
  private active = new Map<Provider, number>();
  private waiting: (() => void)[] = [];
  async run<T>(provider: Provider, fn: () => Promise<T>): Promise<T> {
    while (this.total >= 8 || (this.active.get(provider) ?? 0) >= 4) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.total++; this.active.set(provider, (this.active.get(provider) ?? 0) + 1);
    try { return await fn(); }
    finally { this.total--; this.active.set(provider, this.active.get(provider)! - 1); const waiting = this.waiting.splice(0); waiting.forEach((resolve) => resolve()); }
  }
}
interface SchedulerOptions extends AlertConfiguration { source?: typeof fetchSource; send?: typeof sendBark }
type ActiveRule = PriceAlert & { instrument: Parameters<typeof asInstrument>[0] };

export class AlertScheduler {
  private limiter = new SourceLimiter();
  constructor(readonly repository: AlertRepository, readonly options: SchedulerOptions) {}
  private async guard(signal: AbortSignal) { signal.throwIfAborted(); await this.options.beforeRequest(); signal.throwIfAborted(); }
  async tick() {
    const started = this.repository.clock();
    // Leave time for a final short DB transaction and advisory-lock release
    // before the host curl's 120s deadline; no work is detached from this request.
    const signal = AbortSignal.timeout(90000);
    await this.guard(signal);
    const owners = await this.repository.activeOwners();
    const rules: ActiveRule[] = [];
    for (const owner of owners) rules.push(...await this.repository.activeRules(owner.id));
    const instruments = new Map<string, ActiveRule[]>();
    for (const rule of rules) instruments.set(rule.instrumentId, [...instruments.get(rule.instrumentId) ?? [], rule]);
    const overflow = [...instruments.keys()].slice(50);
    for (const id of overflow) { for (const rule of instruments.get(id)!) await this.repository.recordFailure(rule, "监控产品超过 50 个容量，请暂停部分预警"); instruments.delete(id); }
    const warnings: string[] = [];
    let scans = 0;
    for (const market of ["cn", "us"] as const) {
      const warning = calendarWarning(market, new Date(started)); if (warning) warnings.push(`${market}: ${warning}`);
      const selected = [...instruments.values()].filter((rows) => rows[0].instrument.market === market);
      if (!selected.length) continue;
      let windows: ScanWindow[];
      try { windows = dueWindows(market, this.repository.clock()); }
      catch { for (const row of selected.flat()) await this.repository.recordFailure(row, "交易日历尚未覆盖，已停止自动采集"); continue; }
      await this.warmup(market, selected, signal);
      for (const window of windows) {
        await this.guard(signal);
        const id = `${market}:${window.sessionDate}:${window.end}`;
        const previous = await this.repository.prisma.marketScan.findUnique({ where: { id } });
        if (previous && previous.status !== "running") continue;
        await this.repository.prisma.marketScan.upsert({ where: { id }, create: { id, market, windowEnd: new Date(window.end), status: "running", report: {}, createdAt: new Date(started) }, update: { status: "running" } });
        const reports: unknown[] = [];
        await mapLimited(selected, 8, async (rows) => {
          try { reports.push(await this.collect(rows.filter((r) => r.activeFrom.getTime() < window.end), window, signal)); }
          catch { for (const r of rows) await this.repository.recordFailure(r, "采集任务中断、超时或维护中"); reports.push({ code: rows[0].instrument.code, error: "采集任务中断、超时或维护中" }); }
        });
        const failed = reports.some((r) => r && typeof r === "object" && "error" in r && Boolean(r.error));
        await this.repository.prisma.marketScan.update({ where: { id }, data: { status: failed ? "partial" : "complete", report: jsonValue({ window, instruments: reports, durationMs: this.repository.clock() - started }), finishedAt: new Date(this.repository.clock()) } });
        scans++;
      }
    }
    await this.deliver(owners.map((o) => o.id), signal);
    await this.guard(signal);
    const runtime = await this.repository.prisma.marketScan.findUnique({ where: { id: "runtime" } });
    const prior = runtime?.report && typeof runtime.report === "object" && !Array.isArray(runtime.report) ? runtime.report : {};
    const today = new Date(this.repository.clock()).toISOString().slice(0, 10);
    let cleaned = prior.cleanedDate;
    if (cleaned !== today) { await this.cleanup(signal); cleaned = today; }
    await this.repository.prisma.marketScan.upsert({ where: { id: "runtime" }, create: { id: "runtime", market: "*", windowEnd: new Date(started), status: "idle", report: jsonValue({ heartbeat: new Date(this.repository.clock()).toISOString(), warnings, cleanedDate: cleaned }), createdAt: new Date(started), finishedAt: new Date(this.repository.clock()) }, update: { status: "idle", windowEnd: new Date(started), finishedAt: new Date(this.repository.clock()), report: jsonValue({ heartbeat: new Date(this.repository.clock()).toISOString(), warnings, cleanedDate: cleaned }) } });
    return { scans, products: instruments.size, warnings, durationMs: this.repository.clock() - started };
  }
  private async warmup(market: Market, groups: ActiveRule[][], signal: AbortSignal) {
    const now = this.repository.clock(); const date = dateInZone(now, ZONES[market]);
    let opening: { start: number; end: number } | undefined;
    try { opening = segments(market, date).find((s) => now >= s.start + 15000 && now < s.start + 600000); } catch { return; }
    if (!opening) return;
    const needed = groups.filter((rows) => rows.some((r) => ruleSchema.parse(r.condition).kind !== "price"));
    if (!needed.length) return;
    const id = `${market}:${date}:warmup`;
    if (await this.repository.prisma.marketScan.findUnique({ where: { id } })) return;
    await this.repository.prisma.marketScan.create({ data: { id, market, windowEnd: new Date(opening.start), status: "running", report: {}, createdAt: new Date(now) } });
    const deadline = Math.min(opening.end, now + 120000);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - now))]);
    await mapLimited(needed, 8, async (rows) => {
      const product = asInstrument(rows[0].instrument);
      for (const provider of [market === "cn" ? "tencent" : "yahoo", "eastmoney"] as Provider[]) {
        if (provider === "eastmoney" && !product.eastmoney) break;
        await this.guard(requestSignal);
        const cached = await this.repository.basis(product.id, provider, date);
        if (cached) { try { assertDailyBasis(cached, market, date, provider); break; } catch { /* Replace an unverifiable old cache entry. */ } }
        try {
          await this.limiter.run(provider, async () => {
            const basis = parseDaily(provider, await fetchJson(sourceUrl(provider, product, true), { signal: requestSignal, beforeRequest: async () => { await this.guard(requestSignal); if (this.repository.clock() >= deadline) throw new Error("deadline"); } }), product, date, new Date(this.repository.clock()).toISOString());
            await this.guard(requestSignal);
            await this.repository.saveSource(product, { provider, bars: [], basis, fetchedAt: basis.fetchedAt, error: null, durationMs: 0 }, date, false);
          });
          break;
        } catch { /* Retry the failed preparation at the next scheduled minute window. */ }
      }
    });
    await this.repository.prisma.marketScan.update({ where: { id }, data: { status: "complete", finishedAt: new Date(this.repository.clock()) } });
  }
  private async collect(rows: ActiveRule[], window: ScanWindow, signal: AbortSignal) {
    if (!rows.length) return null;
    const product = asInstrument(rows[0].instrument);
    const wanted = Math.min(...rows.map((r) => Math.max(window.segmentStart, r.cursor?.getTime() ?? r.activeFrom.getTime())));
    const recovery = backfillWindows(window, wanted);
    const range = { ...window, start: recovery.windows[0].start };
    const maxDays = Math.max(0, ...rows.map((r) => { const c = ruleSchema.parse(r.condition); return c.kind === "price" ? 0 : c.days; }));
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, window.deadline - this.repository.clock()))]);
    const beforeRequest = async () => { await this.guard(requestSignal); if (!canFetchWindow(window, this.repository.clock())) throw new Error("行情窗口已结束"); };
    const get = async (provider: Provider) => {
      if (provider === "eastmoney" && !product.eastmoney) return { provider, bars: [], basis: null, fetchedAt: new Date(this.repository.clock()).toISOString(), durationMs: 0, error: "该产品未配置可用备用源" } satisfies SourceResult;
      return this.limiter.run(provider, async () => {
        await beforeRequest();
        return (this.options.source ?? fetchSource)(provider, product, range, maxDays > 0, await this.repository.basis(product.id, provider, window.sessionDate), { signal: requestSignal, beforeRequest });
      });
    };
    const primary = await get(product.market === "cn" ? "tencent" : "yahoo");
    const selected = await selectSources(primary, maxDays > 0, () => get("eastmoney"), maxDays);
    await beforeRequest();
    await this.repository.saveSource(product, primary, window.sessionDate, Boolean(selected.price === primary));
    if (selected.backup) await this.repository.saveSource(product, selected.backup, window.sessionDate, selected.price === selected.backup);
    let failed = 0; let triggers = 0;
    for (const rule of rows) {
      const condition = ruleSchema.parse(rule.condition);
      const source = condition.kind === "price" ? selected.price : [primary, selected.backup].find((s) => s && !s.error && s.basis && s.basis.closes.length >= condition.days - 1);
      if (!source || source.error) { failed++; await this.repository.recordFailure(rule, condition.kind === "price" ? "主备源均未完整覆盖目标分钟" : "主备分钟或均线日线不完整／历史不足"); continue; }
      try {
        if (condition.kind !== "price") historySum(source.basis!, condition.days);
        for (const block of recovery.windows) {
          await this.guard(signal);
          const blockSource = { ...source, bars: source.bars.filter((b) => b.start >= block.start && b.end <= block.end) };
          if (blockSource.bars.length !== 10) throw new Error("分钟缺口");
          const degraded = hasContinuityGap(product.market, Math.max(rule.activeFrom.getTime(), rule.cursor?.getTime() ?? rule.activeFrom.getTime()), recovery.windows[0].start);
          triggers += await this.repository.commitWindow(rule, blockSource, block, window.end, this.options.baseUrl, degraded);
        }
      } catch { failed++; await this.repository.recordFailure(rule, "判定未完成，请检查数据覆盖和均线历史"); }
    }
    return { code: product.code, primary: { provider: primary.provider, error: primary.error, minutes: primary.bars.length, dailyReady: Boolean(primary.basis) }, backup: selected.backup ? { error: selected.backup.error, minutes: selected.backup.bars.length, dailyReady: Boolean(selected.backup.basis) } : null, triggers, missingRules: failed, degraded: recovery.degraded, error: failed ? "部分规则数据不可用" : null };
  }
  private async snapshotDelivery(tx: Prisma.TransactionClient, id: string, status: string, error: string | null, acceptedAt: Date | null, attempts: number) {
    const delivery = JSON.stringify({ status, lastError: error, acceptedAt: acceptedAt?.toISOString() ?? null, attempts });
    await tx.$executeRaw`UPDATE price_alert_events SET evidence = evidence || jsonb_build_object('delivery', ${delivery}::jsonb) WHERE outbox_id = ${id}::uuid`;
  }
  private async deliver(owners: string[], signal: AbortSignal) {
    for (const owner of owners) {
      const now = this.repository.clock();
      const messages = await this.repository.scope(owner, (tx) => tx.priceAlertOutbox.findMany({ where: { OR: [{ status: "pending", nextAttemptAt: { lte: new Date(now) } }, { status: "sending", leaseUntil: { lt: new Date(now) } }] }, orderBy: { createdAt: "asc" }, take: 100 }));
      await mapLimited(messages, 4, async (message) => {
        try {
          await this.guard(signal);
          const claim = await this.repository.scope(owner, async (tx) => {
            await tx.$queryRaw`SELECT id FROM users WHERE id = ${owner}::uuid FOR UPDATE`;
            const user = await tx.user.findUnique({ where: { id: owner } });
            const row = await tx.priceAlertOutbox.findUnique({ where: { id: message.id } });
            const rule = await tx.priceAlert.findUnique({ where: { id: message.ruleId } });
            const channel = await tx.priceAlertChannel.findUnique({ where: { ownerId: owner } });
            if (!row || !["pending", "sending"].includes(row.status)) return null;
            const cancelled = user?.status !== "active" || !rule?.enabled || rule.deletedAt || rule.version !== row.version || !channel?.testedAt || channel.version !== row.channelVersion;
            const status = cancelled ? "cancelled" : row.expiresAt.getTime() <= now ? "expired" : row.attempts >= 3 ? "failed" : null;
            if (status) { await tx.priceAlertOutbox.update({ where: { id: row.id }, data: { status, leaseUntil: null } }); await this.snapshotDelivery(tx, row.id, status, row.lastError, null, row.attempts); return null; }
            const leaseUntil = new Date(now + 30000);
            const claimed = await tx.priceAlertOutbox.update({ where: { id: row.id }, data: { status: "sending", attempts: { increment: 1 }, leaseUntil } });
            return { row: claimed, channel: channel!, leaseUntil };
          });
          if (!claim) return;
          let result: BarkResult;
          try { result = await (this.options.send ?? sendBark)(decryptKey(claim.channel.keyCipher, this.options.encryptionKey), claim.row.payload as unknown as Parameters<typeof sendBark>[1], { signal, beforeRequest: async () => {
            await this.guard(signal);
            const current = await this.repository.detail(owner, claim.row.ruleId);
            const channel = await this.repository.channel(owner);
            const user = await this.repository.prisma.user.findUnique({ where: { id: owner }, select: { status: true } });
            if (!current?.enabled || current.version !== claim.row.version || channel?.version !== claim.row.channelVersion || !channel.testedAt || user?.status !== "active") throw new Error("notification cancelled");
          } }); }
          catch { result = { accepted: false, permanent: false, error: "通知配置变化或发送中断" }; }
          await this.guard(signal);
          await this.repository.scope(owner, async (tx) => {
            await tx.$queryRaw`SELECT id FROM users WHERE id = ${owner}::uuid FOR UPDATE`;
            const next = nextDelivery({ attempts: claim.row.attempts, createdAt: claim.row.createdAt.getTime(), expiresAt: claim.row.expiresAt.getTime() }, this.repository.clock(), result);
            const acceptedAt = result.accepted ? new Date(this.repository.clock()) : null;
            const updated = await tx.priceAlertOutbox.updateMany({ where: { id: message.id, status: "sending", leaseUntil: claim.leaseUntil }, data: { status: next.status, nextAttemptAt: new Date(next.nextAttemptAt), leaseUntil: null, lastError: result.error, acceptedAt } });
            if (updated.count) await this.snapshotDelivery(tx, message.id, next.status, result.error, acceptedAt, claim.row.attempts);
            if (updated.count && result.permanent && !result.accepted) {
              await tx.priceAlertChannel.updateMany({ where: { ownerId: owner, version: claim.row.channelVersion }, data: { testedAt: null, lastError: "Bark 拒绝请求，预警已暂停；请重新测试通知通道" } });
              await tx.priceAlert.updateMany({ where: { enabled: true }, data: { enabled: false, version: { increment: 1 } } });
              await cancelOutbox(tx);
            }
          });
        } catch { /* A lost claim is retried after its finite lease; no unbounded fire-and-forget work. */ }
      });
    }
  }
  private async cleanup(signal: AbortSignal) {
    await this.guard(signal);
    const now = this.repository.clock();
    const purge = async (removeBatch: () => Promise<number>) => {
      for (;;) { await this.guard(signal); if (await removeBatch() < 1000) return; }
    };
    await purge(() => this.repository.prisma.$executeRaw`DELETE FROM market_minutes WHERE ctid IN (SELECT ctid FROM market_minutes WHERE start < ${new Date(now - 7 * 86400000)} LIMIT 1000)`);
    await purge(() => this.repository.prisma.$executeRaw`DELETE FROM market_scans WHERE ctid IN (SELECT ctid FROM market_scans WHERE created_at < ${new Date(now - 7 * 86400000)} AND id <> 'runtime' LIMIT 1000)`);
    const bases = await this.repository.prisma.marketDailyBasis.findMany({ orderBy: { sessionDate: "desc" } });
    const seen = new Map<string, number>();
    for (const basis of bases) { const key = `${basis.instrumentId}:${basis.provider}`; const count = (seen.get(key) ?? 0) + 1; seen.set(key, count); if (count > 2) await this.repository.prisma.marketDailyBasis.delete({ where: { instrumentId_provider_sessionDate: { instrumentId: basis.instrumentId, provider: basis.provider, sessionDate: basis.sessionDate } } }); }
    const owners = await this.repository.prisma.user.findMany({ select: { id: true } });
    let total = 0;
    for (const owner of owners) {
      await this.guard(signal);
      await purge(() => this.repository.scope(owner.id, async (tx) => {
        const expired = await tx.priceAlertEvent.findMany({ where: { createdAt: { lt: new Date(now - 30 * 86400000) } }, select: { id: true }, take: 1000 });
        return (await tx.priceAlertEvent.deleteMany({ where: { id: { in: expired.map((r) => r.id) } } })).count;
      }));
      await purge(() => this.repository.scope(owner.id, async (tx) => {
        const oldQueue = await tx.priceAlertOutbox.findMany({ where: { status: { notIn: ["pending", "sending"] }, createdAt: { lt: new Date(now - 7 * 86400000) } }, select: { id: true }, take: 1000 });
        return (await tx.priceAlertOutbox.deleteMany({ where: { id: { in: oldQueue.map((r) => r.id) } } })).count;
      }));
      await purge(() => this.repository.scope(owner.id, async (tx) => {
        const deleted = await tx.priceAlert.findMany({ where: { deletedAt: { lt: new Date(now - 30 * 86400000) } }, select: { id: true }, take: 1000 });
        return (await tx.priceAlert.deleteMany({ where: { id: { in: deleted.map((r) => r.id) } } })).count;
      }));
      total += await this.repository.scope(owner.id, (tx) => tx.priceAlertEvent.count());
    }
    while (total > 100000 && !signal.aborted) {
      const heads = await Promise.all(owners.map(async (owner) => ({ owner: owner.id, row: await this.repository.scope(owner.id, (tx) => tx.priceAlertEvent.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true, createdAt: true } })) })));
      const head = heads.filter((h) => h.row).sort((a, b) => a.row!.createdAt.getTime() - b.row!.createdAt.getTime())[0];
      if (!head) break;
      await this.guard(signal);
      const count = await this.repository.scope(head.owner, async (tx) => {
        const rows = await tx.priceAlertEvent.findMany({ orderBy: { createdAt: "asc" }, select: { id: true }, take: Math.min(1000, total - 100000) });
        return (await tx.priceAlertEvent.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } })).count;
      });
      total -= count;
    }
  }
}
