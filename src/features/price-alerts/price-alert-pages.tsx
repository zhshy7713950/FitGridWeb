"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ClientApiError } from "@/lib/api-client";
import { alertApi } from "./price-alert-api";
import { formatPrice } from "./price-display";
import { PriceAlertForm } from "./price-alert-form";
import type { AlertCondition, AlertDTO, AlertInput, ChannelStatus, Instrument, InstrumentCandidate } from "./types";
import styles from "./price-alerts.module.css";

function message(error: unknown): string {
  if (error instanceof ClientApiError) {
    if (error.code === "EDIT_CONFLICT") return "提醒已在其他页面更新，请重新载入后再操作";
    return `${error.message}${error.requestId ? `（请求 ID：${error.requestId}）` : ""}`;
  }
  return "连接失败，请重试";
}
function time(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "暂无";
}
function provider(value: string): string {
  return ({ tencent: "腾讯财经", yahoo: "Yahoo Finance", eastmoney: "东方财富" } as Record<string, string>)[value] ?? value;
}
function conditionText(condition: AlertCondition): string {
  const direction = condition.direction === "up" ? "向上触及" : "向下触及";
  if (condition.kind === "price") return `${direction} ${condition.targetPrice}`;
  if (condition.kind === "ma_touch") return `${direction} MA${condition.days}`;
  return `${condition.direction === "up" ? "高于" : "低于"} MA${condition.days} ${condition.percent}%`;
}
function useCached<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then((result) => {
      if (!controller.signal.aborted) setValue(result);
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setError(message(caught));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load, revision]);
  function reload() { setError(""); setLoading(true); setRevision((current) => current + 1); }
  return { value, setValue, error, loading, reload };
}
function Page({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return <div className={styles.page}><header className={styles.heading}><div><p className={styles.eyebrow}>FitGrid / 股价提醒</p><h1>{title}</h1>{description ? <p className={styles.lede}>{description}</p> : null}</div><div className={styles.actions}>{actions}</div></header>{children}</div>;
}
function ErrorNotice({ error, reload }: { error: string; reload?: () => void }) {
  return <div className={styles.error} role="alert">{error}{reload ? <div className={styles.actions}><button type="button" onClick={reload}>重新载入</button></div> : null}</div>;
}
function State({ loading, error, reload }: { loading: boolean; error: string; reload: () => void }) {
  if (loading) return <p role="status" className={styles.status}>正在加载…</p>;
  return error ? <ErrorNotice error={error} reload={reload} /> : null;
}
function AlertStatus({ rule }: { rule: AlertDTO }) {
  const label = rule.deletedAt ? "已删除" : !rule.enabled ? "已暂停" : rule.lastError ? "行情异常" : !rule.armed ? "已提醒，等待离开条件" : "观察中";
  return <span className={`${styles.badge} ${!rule.enabled || rule.deletedAt || !rule.armed ? styles.paused : ""} ${rule.enabled && rule.lastError && !rule.deletedAt ? styles.marketError : ""}`}>{label}</span>;
}

export function AlertListPage() {
  const load = useCallback((signal: AbortSignal) => alertApi.list(signal), []);
  const data = useCached(load);
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const lock = useRef(false);
  async function act(rule: AlertDTO, remove = false) {
    if (lock.current) return;
    lock.current = true; setPending(true); setActionError("");
    try {
      if (remove) {
        await alertApi.remove(rule.id, rule.version);
        data.setValue((current) => current ? { ...current, items: current.items.filter((item) => item.id !== rule.id) } : current);
        setConfirmId(null);
      } else {
        const updated = await alertApi.update(rule.id, { expectedVersion: rule.version, enabled: !rule.enabled });
        data.setValue((current) => current ? { ...current, items: current.items.map((item) => item.id === rule.id ? updated : item) } : current);
      }
    } catch (error) { setActionError(message(error)); }
    finally { lock.current = false; setPending(false); }
  }
  return <Page title="股价提醒" description="为关注的股票与 ETF 设置条件，在价格到达时收到通知。" actions={<><Link href="/settings/notifications">通知设置</Link><Link className={styles.primary} href="/price-alerts/new">创建提醒</Link></>}>
    <State {...data} />
    {actionError ? <ErrorNotice error={actionError} reload={() => { setActionError(""); data.reload(); }} /> : null}
    {data.value && !data.loading && !data.error ? <>
      {data.value.status.calendarWarnings.map((warning, index) => <p key={index} className={styles.warning}>{warning}</p>)}
      <p className={styles.hint}>仅在正常交易时段观察。行情定期检查，刷新页面只查看已保存的数据。下一次检查：{time(data.value.status.nextRunAt)}</p>
      {data.value.items.length ? <div className={styles.list}>{data.value.items.map((rule) => <article className={styles.card} key={rule.id}>
        <div><Link className={styles.identity} href={`/price-alerts/${rule.id}`}>{rule.instrument.name || rule.instrument.code}</Link><span className={styles.code}>{rule.instrument.market === "cn" ? "A 股" : "美股"} · {rule.instrument.code}</span>
          <div className={styles.cachedQuote}>
            <span className={styles.hint}>缓存分钟收盘价</span>
            <span className={styles.quoteValue}>{rule.instrument.currency} {formatPrice(rule.instrument.quote?.price, rule.instrument)}</span>
            {rule.instrument.quote ? <><span>来源：<span>{provider(rule.instrument.quote.provider)}</span></span><span>行情时间：<time dateTime={rule.instrument.quote.minuteEnd}>{time(rule.instrument.quote.minuteEnd)}</time></span></> : <span>暂无缓存行情</span>}
          </div>
        </div>
        <div><p className={styles.condition}>{conditionText(rule.condition)}</p><AlertStatus rule={rule} />{rule.continuityDegraded ? <p className={styles.warning}>历史行情有缺口，可能漏过触发；后续完整分钟继续监控。</p> : null}{rule.lastError ? <p className={styles.error}>{rule.lastError}</p> : null}</div>
        <div className={styles.actions}><Link href={`/price-alerts/${rule.id}`}>查看</Link><button disabled={pending} onClick={() => void act(rule)}>{rule.enabled ? "暂停" : "恢复"}</button><button disabled={pending} className={styles.danger} onClick={() => setConfirmId(rule.id)}>删除</button></div>
        {confirmId === rule.id ? <div role="group" aria-label="删除确认" className={styles.confirm}><span>删除后停止观察，历史记录仍可查看。</span><button disabled={pending} onClick={() => setConfirmId(null)}>取消</button><button disabled={pending} className={styles.danger} onClick={() => void act(rule, true)}>确认删除</button></div> : null}
      </article>)}</div> : <div className={`${styles.panel} ${styles.empty}`}><h2>还没有股价提醒</h2><p>先在通知设置中保存并测试 Bark，再为关注的产品创建提醒。</p><Link href="/price-alerts/new">创建第一条提醒 →</Link></div>}
    </> : null}
  </Page>;
}

const deliveryLabels = { pending: "等待发送", sending: "正在发送", accepted: "Bark 已接收", failed: "发送失败", cancelled: "已取消", expired: "已过期", history: "仅保留记录" };
export function AlertDetailPage({ id }: { id: string }) {
  const load = useCallback(async (signal: AbortSignal) => {
    const [rule, events] = await Promise.all([alertApi.get(id, signal), alertApi.events(id, undefined, signal)]);
    return { rule, events };
  }, [id]);
  const data = useCached(load);
  const [morePending, setMorePending] = useState(false);
  const [moreError, setMoreError] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const actionLock = useRef(false);
  const moreLock = useRef(false);
  async function toggleEnabled() {
    const current = data.value?.rule;
    if (!current || current.deletedAt || data.loading || data.error || actionLock.current) return;
    actionLock.current = true; setActionPending(true); setActionError("");
    try {
      const updated = await alertApi.update(id, { expectedVersion: current.version, enabled: !current.enabled });
      data.setValue((value) => value ? { ...value, rule: updated } : value);
    } catch (error) { setActionError(message(error)); }
    finally { actionLock.current = false; setActionPending(false); }
  }
  async function more() {
    if (!data.value?.events.nextCursor || moreLock.current) return;
    moreLock.current = true; setMorePending(true); setMoreError("");
    try {
      const events = await alertApi.events(id, data.value.events.nextCursor);
      data.setValue((current) => current ? { ...current, events: { ...events, items: [...current.events.items, ...events.items] } } : current);
    } catch (error) { setMoreError(message(error)); }
    finally { moreLock.current = false; setMorePending(false); }
  }
  const rule = data.value?.rule;
  const quote = rule?.instrument.quote;
  const evaluation = rule?.lastEvaluation;
  const snapshot = evaluation ?? quote;
  return <Page title={rule?.instrument.name || "提醒详情"} actions={rule && !rule.deletedAt && !data.loading && !data.error ? <>
      <button disabled={actionPending} aria-busy={actionPending} onClick={() => void toggleEnabled()}>{actionPending ? rule.enabled ? "正在暂停…" : "正在恢复…" : rule.enabled ? "暂停" : "恢复"}</button>
      <Link href={`/price-alerts/${id}/edit`}>编辑提醒</Link>
    </> : null}>
    <Link className={styles.back} href="/price-alerts">← 返回股价提醒</Link><State {...data} />
    {actionError ? <ErrorNotice error={actionError} reload={() => { setActionError(""); data.reload(); }} /> : null}
    {rule && !data.loading && !data.error ? <>
      <div className={styles.columns}><section className={styles.panel} aria-label="行情快照"><p className={styles.code}>{rule.instrument.market === "cn" ? "A 股" : "美股"} · {rule.instrument.code} · {rule.instrument.currency}</p><dl className={styles.priceSummary}>
          <div><dt>股票价格（分钟收盘价）</dt><dd className={styles.price}>{formatPrice(snapshot?.price, rule.instrument)}</dd></div>
          {rule.condition.kind !== "price" ? <div><dt>MA{rule.condition.days} 均线价格（计算值）</dt><dd className={styles.price}>{evaluation?.ma != null ? formatPrice(evaluation.ma, rule.instrument) : "尚未计算"}</dd></div> : null}
        </dl><p className={styles.hint}>{evaluation ? "最近有效判断的分钟收盘价" : "缓存分钟收盘价"}</p><div className={styles.conditionSummary} role="group" aria-label="提醒条件"><span>{conditionText(rule.condition)}</span><span className={styles.triggerPrice} aria-label="触发价格">触发价 {evaluation?.threshold != null || rule.condition.kind === "price" ? `${rule.instrument.currency === "CNY" ? "¥" : "$"}${formatPrice(evaluation?.threshold ?? (rule.condition.kind === "price" ? rule.condition.targetPrice : null), rule.instrument)}` : "待计算"}</span></div><AlertStatus rule={rule} />
        <dl className={styles.metrics}><div><dt>行情来源</dt><dd>{snapshot ? provider(snapshot.provider) : "暂无"}</dd></div><div><dt>行情时间</dt><dd>{time(snapshot?.minuteEnd)}</dd></div><div><dt>获取时间</dt><dd>{time(snapshot?.fetchedAt)}</dd></div><div><dt>开始观察</dt><dd>{time(rule.activeFrom)}</dd></div></dl>
        {!evaluation && rule.condition.kind !== "price" ? <p className={styles.hint}>均线尚未就绪，等待有效判断</p> : null}
        {evaluation ? <p className={styles.hint}>最近判断：{time(evaluation.minuteEnd)} · {provider(evaluation.provider)}{evaluation.adjustment ? ` · ${evaluation.adjustment}` : ""}</p> : null}
      </section><aside className={styles.panel}><h2>观察说明</h2><p className={styles.hint}>动态均线包含当前价格。达到边界也会触发；分钟收盘离开条件范围后，才会再次提醒。</p><p className={styles.hint}>新建或恢复提醒，从下一个完整分钟开始观察。首次已符合条件时也会提醒一次。每条提醒每轮检查最多推送一次。</p><p className={styles.hint}>页面只展示已保存的行情。Bark 接收成功并不代表设备已经展示通知。</p>{rule.continuityDegraded ? <p className={styles.warning}>历史行情有缺口，可能漏过触发；保留原有观察状态，后续完整分钟继续监控。</p> : null}{rule.lastError ? <p role="alert" className={styles.error}>{rule.lastError}</p> : null}{!rule.instrument.eastmoney ? <p className={styles.warning}>此产品暂时没有备用行情来源。</p> : null}</aside></div>
      <section className={`${styles.panel} ${styles.events}`}><h2>提醒记录</h2>{data.value?.events.items.length ? data.value.events.items.map((event) => <article className={styles.event} key={event.id}><time dateTime={event.minuteEnd}>{time(event.minuteEnd)}</time><p>{event.evidence.condition ? conditionText(event.evidence.condition) : "价格到达条件"} · 触发时股价 {formatPrice(event.price, rule.instrument)} · 触发边界价格 {formatPrice(event.threshold, rule.instrument)}{event.ma ? ` · 触发时均线价格${event.evidence.condition && event.evidence.condition.kind !== "price" ? `（MA${event.evidence.condition.days}）` : ""}${formatPrice(event.ma, rule.instrument)}` : ""}</p><div className={styles.actions}><span className={styles.badge}>{deliveryLabels[event.delivery.status]}</span>{event.evidence.delayed ? <span className={styles.badge}>延迟补发</span> : null}</div><p className={styles.hint}>{provider(event.provider)} · 尝试 {event.delivery.attempts} 次{event.delivery.acceptedAt ? ` · 接收于 ${time(event.delivery.acceptedAt)}` : ""}</p>{event.delivery.lastError ? <p className={styles.error}>{event.delivery.lastError}</p> : null}</article>) : <p className={styles.hint}>还没有提醒记录。</p>}{moreError ? <ErrorNotice error={moreError} /> : null}{data.value?.events.nextCursor ? <button disabled={morePending} onClick={() => void more()}>{morePending ? "正在加载…" : "加载更早记录"}</button> : null}</section>
    </> : null}
  </Page>;
}

export function AlertEditorPage({ id, prefill }: { id?: string; prefill?: { code?: string; market?: "cn" | "us" } }) {
  if (id) return <EditAlert id={id} />;
  return <NewAlert prefill={prefill} />;
}
function NewAlert({ prefill }: { prefill?: { code?: string; market?: "cn" | "us" } }) {
  const router = useRouter();
  const [market, setMarket] = useState<"cn" | "us">(prefill?.market ?? "cn");
  const [code, setCode] = useState(prefill?.code ?? "");
  const [instrument, setInstrument] = useState<Instrument | null>(null);
  const [candidates, setCandidates] = useState<InstrumentCandidate[]>([]);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const resolveLock = useRef(false);
  function invalidate() {
    generation.current += 1; setInstrument(null); setCandidates([]); setSearched(false); setError("");
  }
  async function search() {
    if (resolveLock.current || !code.trim()) return;
    resolveLock.current = true; setPending(true); setError(""); setInstrument(null); setCandidates([]); setSearched(false);
    const current = ++generation.current;
    try { const result = await alertApi.search(market, code.trim()); if (current === generation.current) { setCandidates(result.items); setSearched(true); } }
    catch (caught) { if (current === generation.current) setError(message(caught)); }
    finally { resolveLock.current = false; setPending(false); }
  }
  async function confirm(candidate: InstrumentCandidate) {
    if (resolveLock.current) return;
    resolveLock.current = true; setPending(true); setError("");
    const current = ++generation.current;
    try { const result = await alertApi.resolve(market, candidate.code); if (current === generation.current) { setInstrument(result); setCandidates([]); setSearched(false); } }
    catch (caught) { if (current === generation.current) setError(message(caught)); }
    finally { resolveLock.current = false; setPending(false); }
  }
  async function create(input: AlertInput) {
    if (!instrument) return;
    setError("");
    try { const created = await alertApi.create({ ...input, instrumentId: instrument.id }); router.push(`/price-alerts/${created.id}`); }
    catch (caught) { setError(message(caught)); throw caught; }
  }
  return <Page title="创建提醒" description="搜索股票或 ETF 的代码、名称，确认产品后设置条件。" actions={<Link href="/settings/notifications">通知设置</Link>}><Link className={styles.back} href="/price-alerts">← 返回股价提醒</Link><div className={styles.columns}><section className={styles.panel}><h2>选择产品</h2><div className={styles.form}>
    <label htmlFor="alert-market">市场</label><select id="alert-market" value={market} onChange={(event) => { invalidate(); setMarket(event.target.value as "cn" | "us"); }}><option value="cn">A 股 · 股票 / ETF</option><option value="us">美股 · 股票 / ETF</option></select>
    <label htmlFor="instrument-code">产品代码或名称</label><input id="instrument-code" autoComplete="off" maxLength={64} value={code} placeholder={market === "cn" ? "例如 510880 或 红利" : "例如 AAPL 或 Apple"} onChange={(event) => { invalidate(); setCode(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void search(); } }} /><button disabled={pending || !code.trim()} onClick={() => void search()}>{pending ? "正在查询…" : "搜索产品"}</button>
    {searched && candidates.length === 0 ? <p role="status" className={styles.hint}>没有找到支持的股票或 ETF，请调整代码或名称。</p> : null}
    {candidates.length ? <div aria-label="检索结果">{candidates.map((candidate) => <div className={styles.event} key={candidate.code}><h3>{candidate.name}</h3><p className={styles.code}>{candidate.code} · {candidate.exchange} · {candidate.kind === "etf" ? "ETF" : "股票"}</p><button disabled={pending} aria-label={`确认选择 ${candidate.name} ${candidate.code}`} onClick={() => void confirm(candidate)}>确认选择</button></div>)}</div> : null}
    {instrument ? <div><h3>{instrument.name}</h3><p className={styles.code}>{instrument.code} · {instrument.currency}</p>{!instrument.eastmoney ? <p className={styles.warning}>此产品暂时没有备用行情来源。</p> : null}</div> : null}
    </div></section><section className={styles.panel}><h2>设置条件</h2>{instrument ? <PriceAlertForm key={instrument.id} onSubmit={create} /> : <p className={styles.hint}>先搜索并确认产品，再设置提醒条件。</p>}{error ? <ErrorNotice error={error} /> : null}</section></div></Page>;
}
function EditAlert({ id }: { id: string }) {
  const router = useRouter();
  const load = useCallback((signal: AbortSignal) => alertApi.get(id, signal), [id]);
  const data = useCached(load);
  const [error, setError] = useState("");
  async function save(input: AlertInput) {
    if (!data.value) return;
    setError("");
    try { await alertApi.update(id, { ...input, expectedVersion: data.value.version }); router.push(`/price-alerts/${id}`); }
    catch (caught) { setError(message(caught)); throw caught; }
  }
  return <Page title="编辑提醒" description={data.value ? `${data.value.instrument.name} · ${data.value.instrument.code}` : undefined}><Link className={styles.back} href={`/price-alerts/${id}`}>← 返回提醒详情</Link><State {...data} />{data.value && !data.loading && !data.error ? data.value.deletedAt ? <p className={styles.warning}>提醒已删除，只能查看历史记录。</p> : <section className={styles.panel}><PriceAlertForm key={`${id}-${data.value.version}`} initial={data.value} onSubmit={save} />{error ? <ErrorNotice error={error} reload={() => { setError(""); data.reload(); }} /> : null}</section> : null}</Page>;
}

export function NotificationSettingsPage() {
  const load = useCallback((signal: AbortSignal) => alertApi.channel(signal), []);
  const data = useCached(load);
  const [key, setKey] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const lock = useRef(false);
  async function act(action: "save" | "test" | "remove") {
    if (lock.current || !data.value) return;
    if ((action === "remove" || action === "save" && data.value.configured) && !acknowledged) return;
    lock.current = true; setPending(true); setError(""); setSuccess("");
    try {
      if (action === "save") { const status = await alertApi.saveChannel(key.trim()); setKey(""); data.setValue(status); setSuccess("设备 Key 已保存。请发送测试通知，再手动恢复需要的提醒。"); }
      else if (action === "test") { await alertApi.testChannel(); data.setValue(await alertApi.channel()); setSuccess("Bark 已接收测试通知，请检查设备。"); }
      else { await alertApi.removeChannel(); data.setValue((current) => current ? { ...current, configured: false, tested: false, testedAt: null, lastError: null } : current); setKey(""); setSuccess("通知设备已移除，全部提醒已暂停。"); }
      setAcknowledged(false);
    } catch (caught) { setError(message(caught)); }
    finally { lock.current = false; setPending(false); }
  }
  const status: ChannelStatus | null = data.value;
  return <Page title="通知设置" description="使用 Bark 将股价提醒发送到你的设备。" actions={<Link href="/price-alerts">股价提醒</Link>}><State {...data} />{status && !data.loading && !data.error ? <div className={styles.columns}><section className={styles.panel}><h2>Bark 设备</h2><div className={styles.actions}><span className={styles.badge}>{status.configured ? "已配置" : "未配置"}</span><span className={`${styles.badge} ${status.tested ? "" : styles.paused}`}>{status.tested ? "测试成功" : "尚未测试"}</span></div><p className={styles.hint}>最近测试：{time(status.testedAt)}</p>{status.lastError ? <p className={styles.error}>{status.lastError}</p> : null}{!status.encryptionReady ? <p className={styles.warning}>通知设置暂不可用，请联系管理员。</p> : null}
      <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void act("save"); }}><label htmlFor="bark-key">Bark 设备 Key</label><input id="bark-key" type="password" autoComplete="new-password" value={key} disabled={pending || !status.encryptionReady} onChange={(event) => setKey(event.target.value)} placeholder="粘贴设备 Key" /><p className={styles.hint}>只需输入设备 Key，无需完整网址。已保存的 Key 不会回显。</p>
      {status.configured ? <label className={styles.checkbox}><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />我知道此操作会暂停全部提醒</label> : null}
      <button className={styles.primary} disabled={pending || !key.trim() || !status.encryptionReady || status.configured && !acknowledged}>保存设备 Key</button></form>
      <div className={styles.actions}><button disabled={pending || !status.configured || !status.encryptionReady} onClick={() => void act("test")}>发送测试通知</button><button className={styles.danger} disabled={pending || !status.configured || !acknowledged} onClick={() => void act("remove")}>移除设备</button></div>{error ? <ErrorNotice error={error} /> : null}{success ? <p role="status" className={styles.success}>{success}</p> : null}
    </section><aside className={styles.panel}><h2>启用提醒前</h2><p className={styles.hint}>在 Bark 中复制设备 Key，保存后发送测试通知。测试成功后，才可启用股价提醒。</p><p className={styles.warning}>替换或移除设备 Key 会暂停全部提醒。保存新 Key 并测试成功后，请手动恢复需要的提醒。</p><p className={styles.hint}>Bark 接收成功表示通知已提交给 Bark；设备是否显示还受系统通知权限与网络状态影响。</p></aside></div> : null}</Page>;
}
