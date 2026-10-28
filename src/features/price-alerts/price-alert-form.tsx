"use client";

import { useRef, useState, type FormEvent } from "react";
import type { AlertCondition, AlertInput } from "./types";
import styles from "./price-alerts.module.css";

export function PriceAlertForm({ initial, onSubmit }: {
  initial?: AlertInput; onSubmit: (input: AlertInput) => Promise<void>;
}) {
  const [kind, setKind] = useState<AlertCondition["kind"]>(initial?.condition.kind ?? "price");
  const [direction, setDirection] = useState<"up" | "down">(initial?.condition.direction ?? "up");
  const [targetPrice, setPrice] = useState(initial?.condition.kind === "price" ? initial.condition.targetPrice : "");
  const [days, setDays] = useState(String(initial && initial.condition.kind !== "price" ? initial.condition.days : 20));
  const [percent, setPercent] = useState(initial?.condition.kind === "ma_deviation" ? initial.condition.percent : "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const lock = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    setError("");
    if (kind === "price" && (!/^\d+(\.\d+)?$/.test(targetPrice) || !Number.isFinite(Number(targetPrice)) || Number(targetPrice) <= 0)) {
      setError("目标价格必须大于 0"); return;
    }
    if (kind !== "price" && (!/^\d+$/.test(days) || Number(days) < 2 || Number(days) > 250)) {
      setError("均线天数必须为 2–250 的整数"); return;
    }
    if (kind === "ma_deviation" && (!/^\d+(\.\d{1,2})?$/.test(percent) || Number(percent) < 0.01 || Number(percent) > 99.99)) {
      setError("偏离幅度必须为 0.01–99.99，最多两位小数"); return;
    }
    const condition: AlertCondition = kind === "price" ? { kind, direction, targetPrice }
      : kind === "ma_touch" ? { kind, direction, days: Number(days) }
      : { kind, direction, days: Number(days), percent };
    lock.current = true; setPending(true);
    try { await onSubmit({ condition, enabled }); }
    catch { /* The page displays server errors alongside the form. */ }
    finally { lock.current = false; setPending(false); }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <label htmlFor="alert-kind">提醒条件</label>
      <select id="alert-kind" value={kind} onChange={(event) => setKind(event.target.value as AlertCondition["kind"])}>
        <option value="price">价格到达</option><option value="ma_touch">触及均线</option><option value="ma_deviation">偏离均线</option>
      </select>
      <label htmlFor="alert-direction">触发方向</label>
      <select id="alert-direction" value={direction} onChange={(event) => setDirection(event.target.value as "up" | "down")}>
        <option value="up">向上触及</option><option value="down">向下触及</option>
      </select>
      {kind === "price" ? <>
        <label htmlFor="alert-price">目标价格</label>
        <input id="alert-price" inputMode="decimal" value={targetPrice} onChange={(event) => setPrice(event.target.value)} placeholder="例如 6.9200" />
      </> : <>
        <label htmlFor="alert-days">均线天数</label>
        <input id="alert-days" inputMode="numeric" value={days} onChange={(event) => setDays(event.target.value)} aria-describedby="ma-help" />
        <p className={styles.hint} id="ma-help">2–250 天。动态均线包含当前价格，以及此前 N−1 个交易日的复权收盘价。</p>
      </>}
      {kind === "ma_deviation" ? <>
        <label htmlFor="alert-percent">偏离幅度（%）</label>
        <input id="alert-percent" inputMode="decimal" value={percent} onChange={(event) => setPercent(event.target.value)} placeholder="例如 5.00" />
        <p className={styles.hint}>向上表示高于均线，向下表示低于均线；0.01–99.99%。</p>
      </> : null}
      <label className={styles.checkbox}><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />保存后启用</label>
      <p className={styles.hint}>达到边界也会触发。启用后，从下一个完整分钟开始观察；首个分钟已符合条件时会提醒一次。分钟收盘离开条件范围后，才会再次提醒。每条提醒每轮检查最多推送一次。</p>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      <button className={styles.primary} disabled={pending}>{pending ? "正在保存…" : "保存提醒"}</button>
    </form>
  );
}
