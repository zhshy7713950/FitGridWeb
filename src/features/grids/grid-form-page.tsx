"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ClientApiError } from "@/lib/api-client";

import { createGridTrade, getGridTrade, updateGridTrade } from "./grid-api";
import { GridForm } from "./grid-form";
import {
  defaultGridFormValues,
  detailToFormValues,
} from "./grid-form-model";
import type { GridTradeDetail, GridTradeMutationInput } from "./types";
import styles from "./grid-form.module.css";

type SubmitErrors = {
  fieldErrors: Record<string, string[]>;
  formError: string | null;
  requestId?: string;
};

type LoadErrorState = {
  message: string;
  requestId?: string;
  retryable: boolean;
};

const emptyErrors: SubmitErrors = { fieldErrors: {}, formError: null };

function errorState(error: unknown, fallback: string): SubmitErrors {
  if (error instanceof ClientApiError) {
    if (error.code === "EDIT_CONFLICT") {
      return {
        fieldErrors: {},
        formError: "产品已在其他页面更新，请重新载入后再编辑",
        requestId: error.requestId,
      };
    }
    return {
      fieldErrors: error.fieldErrors ?? {},
      formError: error.message || fallback,
      requestId: error.requestId,
    };
  }
  return { fieldErrors: {}, formError: fallback };
}

function withoutFieldError(errors: SubmitErrors, name: string): SubmitErrors {
  if (!errors.fieldErrors[name]) return errors;
  const fieldErrors = { ...errors.fieldErrors };
  delete fieldErrors[name];
  return { ...errors, fieldErrors };
}

function loadErrorState(error: unknown): LoadErrorState {
  if (error instanceof ClientApiError) {
    return {
      message: error.status === 404 ? "网格产品不存在" : error.message,
      requestId: error.requestId,
      retryable: error.status !== 404,
    };
  }
  return { message: "加载产品失败，请重试", retryable: true };
}

export function NewGridFormPage() {
  const router = useRouter();
  const [errors, setErrors] = useState<SubmitErrors>(emptyErrors);

  async function create(input: GridTradeMutationInput) {
    setErrors(emptyErrors);
    try {
      const created = await createGridTrade(input);
      router.push(`/grids/${created.id}`);
    } catch (error) {
      setErrors(errorState(error, "创建产品失败，请重试"));
      throw error;
    }
  }

  return (
    <GridForm
      initialValues={defaultGridFormValues}
      submitLabel="创建产品"
      onSubmit={create}
      serverFieldErrors={errors.fieldErrors}
      formError={errors.formError}
      requestId={errors.requestId}
      onFieldEdit={(name) => setErrors((current) => withoutFieldError(current, name))}
    />
  );
}

export function EditGridFormPage({ id }: { id: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<GridTradeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadErrorState | null>(null);
  const [errors, setErrors] = useState<SubmitErrors>(emptyErrors);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void getGridTrade(id, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setDetail(loaded);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setDetail(null);
          setLoadError(loadErrorState(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, reloadKey]);

  function reload() {
    setLoading(true);
    setLoadError(null);
    setReloadKey((value) => value + 1);
  }

  async function update(input: GridTradeMutationInput) {
    if (!detail) return;
    setErrors(emptyErrors);
    try {
      await updateGridTrade(id, {
        ...input,
        expectedUpdatedAt: detail.updatedAt,
      });
      router.push(`/grids/${id}`);
    } catch (error) {
      setErrors(errorState(error, "保存产品失败，请重试"));
      throw error;
    }
  }

  if (loading) {
    return <div className={styles.pageStatus} role="status">正在加载产品…</div>;
  }

  if (loadError || !detail) {
    const visibleError = loadError ?? {
      message: "加载产品失败，请重试",
      retryable: true,
    };
    return (
      <div className={styles.loadError} role="alert">
        <div className={styles.loadErrorMessage}>
          <span>{visibleError.message}</span>
          {visibleError.requestId ? <small>请求 ID：{visibleError.requestId}</small> : null}
        </div>
        {visibleError.retryable ? <button type="button" onClick={reload}>重试</button> : null}
      </div>
    );
  }

  return (
    <GridForm
      initialValues={detailToFormValues(detail)}
      submitLabel="保存修改"
      onSubmit={update}
      serverFieldErrors={errors.fieldErrors}
      formError={errors.formError}
      requestId={errors.requestId}
      onFieldEdit={(name) => setErrors((current) => withoutFieldError(current, name))}
    />
  );
}
