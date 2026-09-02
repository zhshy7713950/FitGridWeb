"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  validateGridForm,
  type GridFormValues,
} from "./grid-form-model";
import type { GridTradeMutationInput } from "./types";
import { useUnsavedChangesGuard } from "./use-unsaved-changes-guard";
import styles from "./grid-form.module.css";

export type GridFormProps = {
  initialValues: GridFormValues;
  submitLabel: string;
  onSubmit(input: GridTradeMutationInput): Promise<void>;
  serverFieldErrors?: Record<string, string[]>;
  formError?: string | null;
  requestId?: string;
  onFieldEdit?: (name: keyof GridFormValues) => void;
};

type FieldName = Exclude<keyof GridFormValues, "isShort">;

type FieldDefinition = {
  name: FieldName;
  label: string;
  inputMode?: "decimal" | "numeric" | "text";
  placeholder?: string;
  suffix?: string;
  className?: string;
};

const identityFields: FieldDefinition[] = [
  { name: "productName", label: "产品名称", placeholder: "例如：指数基金" },
  { name: "productCode", label: "产品代码", placeholder: "例如：518880", className: styles.codeField },
  { name: "category", label: "分类", placeholder: "例如：ETF" },
  { name: "sortOrder", label: "排序", inputMode: "text" },
];

const ladderFields: FieldDefinition[] = [
  { name: "maxPrice", label: "最高价格", inputMode: "decimal" },
  { name: "minTradeQuantity", label: "最小交易数量", inputMode: "decimal" },
  { name: "gearAmplitude", label: "档位幅度", inputMode: "decimal", suffix: "%" },
  { name: "maxAmplitude", label: "最大振幅", inputMode: "numeric", suffix: "%" },
];

const positionFields: FieldDefinition[] = [
  { name: "perShare", label: "每份金额", inputMode: "decimal" },
  { name: "increaseAmplitude", label: "加码幅度", inputMode: "numeric", suffix: "%" },
];

const longOnlyFields: FieldDefinition[] = [
  { name: "keepShare", label: "留存份数", inputMode: "numeric" },
  { name: "mediumAmplitude", label: "中网幅度", inputMode: "numeric", suffix: "%" },
  { name: "bigAmplitude", label: "大网幅度", inputMode: "numeric", suffix: "%" },
];

export function GridForm({
  initialValues,
  submitLabel,
  onSubmit,
  serverFieldErrors = {},
  formError,
  requestId,
  onFieldEdit,
}: GridFormProps) {
  const [values, setValues] = useState<GridFormValues>(initialValues);
  const [clientFieldErrors, setClientFieldErrors] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [initialSnapshot] = useState(() => JSON.stringify(initialValues));
  const productCodeInput = useRef<HTMLInputElement>(null);
  const productCodeServerErrors = serverFieldErrors.productCode;
  const dirty = useMemo(
    () => JSON.stringify(values) !== initialSnapshot,
    [initialSnapshot, values],
  );

  useUnsavedChangesGuard(dirty);

  useEffect(() => {
    if (productCodeServerErrors?.length) productCodeInput.current?.focus();
  }, [productCodeServerErrors]);

  function updateField(name: FieldName, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
    onFieldEdit?.(name);
    setClientFieldErrors((current) => {
      if (!current[name]) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  }

  function fieldErrors(name: FieldName) {
    return clientFieldErrors[name] ?? serverFieldErrors[name] ?? [];
  }

  function renderField(field: FieldDefinition) {
    const errors = fieldErrors(field.name);
    const errorId = errors.length ? `${field.name}-error` : undefined;
    return (
      <div className={`${styles.field} ${field.className ?? ""}`} key={field.name}>
        <label htmlFor={`grid-${field.name}`}>{field.label}</label>
        <div className={styles.inputFrame}>
          <input
            id={`grid-${field.name}`}
            name={field.name}
            type="text"
            inputMode={field.inputMode}
            autoComplete="off"
            ref={field.name === "productCode" ? productCodeInput : undefined}
            value={values[field.name]}
            placeholder={field.placeholder}
            aria-invalid={errors.length ? true : undefined}
            aria-describedby={errorId}
            onChange={(event) => updateField(field.name, event.target.value)}
          />
          {field.suffix ? <span aria-hidden="true">{field.suffix}</span> : null}
        </div>
        {errors.length ? (
          <p id={errorId} className={styles.fieldError} role="alert">
            {errors.join("；")}
          </p>
        ) : null}
      </div>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;

    const result = validateGridForm(values);
    setClientFieldErrors(result.fieldErrors);
    if (!result.input) return;

    setSaving(true);
    try {
      await onSubmit(result.input);
    } catch {
      setSaving(false);
    }
  }

  return (
    <form className={styles.form} noValidate onSubmit={submit}>
      <div className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>Grid instrument · 参数面板</span>
          <h1>{submitLabel === "创建产品" ? "新增网格产品" : "编辑网格产品"}</h1>
        </div>
        <p>输入策略参数，计算将在保存后由服务器完成。</p>
      </div>

      {formError || requestId ? (
        <div className={styles.formError} role="alert" aria-label="表单错误">
          <div className={styles.loadErrorMessage}>
            {formError ? <span>{formError}</span> : null}
            {requestId ? <small>请求 ID：{requestId}</small> : null}
          </div>
        </div>
      ) : null}

      <div className={styles.panel}>
        <div className={styles.ladderSpine} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        <fieldset className={styles.fieldset} aria-labelledby="grid-identity-legend">
          <legend id="grid-identity-legend">产品标识</legend>
          <p>用于搜索、识别与排序，不参与网格计算。</p>
          <div className={styles.fields}>{identityFields.map(renderField)}</div>
        </fieldset>

        <fieldset className={styles.fieldset} aria-labelledby="grid-ladder-legend">
          <legend id="grid-ladder-legend">价格阶梯</legend>
          <p>定义价格上界、交易单位与每档间距。</p>
          <div className={styles.fields}>{ladderFields.map(renderField)}</div>
        </fieldset>

        <fieldset className={styles.fieldset} aria-labelledby="grid-position-legend">
          <legend id="grid-position-legend">仓位规则</legend>
          <p>选择交易方向，并设置各级网格的资金与加码规则。</p>
          <div className={styles.directionField}>
            <span id="grid-direction-label">交易方向</span>
            <div className={styles.direction} role="group" aria-labelledby="grid-direction-label">
              <button
                type="button"
                className={styles.longButton}
                aria-pressed={!values.isShort}
                onClick={() => {
                  setValues((current) => ({ ...current, isShort: false }));
                  onFieldEdit?.("isShort");
                }}
              >
                做多
              </button>
              <button
                type="button"
                className={styles.shortButton}
                aria-pressed={values.isShort}
                onClick={() => {
                  setValues((current) => ({
                    ...current,
                    isShort: true,
                    keepShare: "",
                    mediumAmplitude: "",
                    bigAmplitude: "",
                  }));
                  onFieldEdit?.("isShort");
                }}
              >
                做空
              </button>
            </div>
          </div>
          <div className={styles.fields}>
            {positionFields.map(renderField)}
            {!values.isShort ? longOnlyFields.map(renderField) : null}
          </div>
        </fieldset>
      </div>

      <div className={styles.actions}>
        <Link href="/grids">取消</Link>
        <button type="submit" disabled={saving} aria-busy={saving}>
          {saving ? "正在保存…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
