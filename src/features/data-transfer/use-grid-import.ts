"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ClientApiError } from "@/lib/api-client";

import { commitImport, previewImport } from "./data-transfer-api";
import { isPreviewExpired, validateImportFile } from "./import-model";
import type { ImportConflictPolicy, ImportPreview, ImportReport } from "./types";

export type GridImportState =
  | { stage: "select"; error: string | null }
  | { stage: "previewing"; filename: string }
  | {
      stage: "preview";
      filename: string;
      preview: ImportPreview;
      policy: ImportConflictPolicy;
      error: string | null;
    }
  | {
      stage: "committing";
      filename: string;
      preview: ImportPreview;
      policy: ImportConflictPolicy;
    }
  | { stage: "complete"; report: ImportReport };

export type PreviewImportRequest = (file: File) => Promise<ImportPreview>;
export type CommitImportRequest = (
  previewToken: string,
  conflictPolicy: ImportConflictPolicy,
) => Promise<ImportReport>;

export interface GridImportController {
  state: GridImportState;
  selectFile(file: File): Promise<void>;
  setPolicy(policy: ImportConflictPolicy): void;
  commit(policy?: ImportConflictPolicy): Promise<void>;
  reset(): void;
}

interface PreviewOperation {
  file: File;
  promise: Promise<void>;
}

interface CommitOperation {
  promise: Promise<void>;
}

const INITIAL_STATE: GridImportState = { stage: "select", error: null };

function publicError(error: unknown, fallback: string): string {
  if (error instanceof TypeError) return "网络连接失败，请重试";
  if (error instanceof ClientApiError) {
    return error.requestId ? `${error.message}，请求 ID：${error.requestId}` : error.message;
  }
  return fallback;
}

function missingPreviewError(error: ClientApiError): string {
  const message = "导入预检已过期或已使用，请重新选择文件";
  return error.requestId ? `${message}，请求 ID：${error.requestId}` : message;
}

export function useGridImport(
  {
    previewRequest = previewImport,
    commitRequest = commitImport,
    now = () => new Date(),
  }: {
    previewRequest?: PreviewImportRequest;
    commitRequest?: CommitImportRequest;
    now?: () => Date;
  } = {},
): GridImportController {
  const [state, setState] = useState<GridImportState>(INITIAL_STATE);
  const stateRef = useRef<GridImportState>(INITIAL_STATE);
  const mounted = useRef(true);
  const generation = useRef(0);
  const previewOperation = useRef<PreviewOperation | null>(null);
  const commitOperation = useRef<CommitOperation | null>(null);
  const previewRequestRef = useRef(previewRequest);
  const commitRequestRef = useRef(commitRequest);
  const nowRef = useRef(now);

  useEffect(() => {
    previewRequestRef.current = previewRequest;
    commitRequestRef.current = commitRequest;
    nowRef.current = now;
  }, [commitRequest, now, previewRequest]);

  const transition = useCallback((next: GridImportState) => {
    stateRef.current = next;
    if (mounted.current) setState(next);
  }, []);

  useEffect(() => {
    const lifetimeGeneration = generation;
    const lifetimePreviewOperation = previewOperation;
    const lifetimeCommitOperation = commitOperation;
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++lifetimeGeneration.current;
      lifetimePreviewOperation.current = null;
      lifetimeCommitOperation.current = null;
    };
  }, []);

  const reset = useCallback(() => {
    ++generation.current;
    previewOperation.current = null;
    commitOperation.current = null;
    transition(INITIAL_STATE);
  }, [transition]);

  const selectFile = useCallback((file: File): Promise<void> => {
    if (previewOperation.current?.file === file) return previewOperation.current.promise;

    const validationError = validateImportFile(file);
    ++generation.current;
    previewOperation.current = null;
    commitOperation.current = null;
    if (validationError) {
      transition({ stage: "select", error: validationError });
      return Promise.resolve();
    }

    const operationGeneration = generation.current;
    transition({ stage: "previewing", filename: file.name });
    const operation: PreviewOperation = { file, promise: Promise.resolve() };
    previewOperation.current = operation;

    let request: Promise<ImportPreview>;
    try {
      request = previewRequestRef.current(file);
    } catch (error) {
      request = Promise.reject(error);
    }
    operation.promise = request
      .then(
        (preview) => {
          if (!mounted.current || operationGeneration !== generation.current) return;
          transition({
            stage: "preview",
            filename: file.name,
            preview,
            policy: "skip",
            error: null,
          });
        },
        (error: unknown) => {
          if (!mounted.current || operationGeneration !== generation.current) return;
          transition({ stage: "select", error: publicError(error, "导入预检失败，请重试") });
        },
      )
      .finally(() => {
        if (previewOperation.current === operation) previewOperation.current = null;
      });
    return operation.promise;
  }, [transition]);

  const setPolicy = useCallback((policy: ImportConflictPolicy) => {
    const current = stateRef.current;
    if (current.stage !== "preview") return;
    transition({ ...current, policy });
  }, [transition]);

  const commit = useCallback((policyOverride?: ImportConflictPolicy): Promise<void> => {
    if (commitOperation.current) return commitOperation.current.promise;
    const current = stateRef.current;
    if (current.stage !== "preview") return Promise.resolve();

    const policy = policyOverride ?? current.policy;
    if (isPreviewExpired(current.preview, nowRef.current())) {
      ++generation.current;
      previewOperation.current = null;
      transition({ stage: "select", error: "导入预检已过期，请重新选择文件" });
      return Promise.resolve();
    }

    const operationGeneration = ++generation.current;
    transition({
      stage: "committing",
      filename: current.filename,
      preview: current.preview,
      policy,
    });
    const operation: CommitOperation = { promise: Promise.resolve() };
    commitOperation.current = operation;

    let request: Promise<ImportReport>;
    try {
      request = commitRequestRef.current(current.preview.previewToken, policy);
    } catch (error) {
      request = Promise.reject(error);
    }
    operation.promise = request
      .then(
        (report) => {
          if (!mounted.current || operationGeneration !== generation.current) return;
          transition({ stage: "complete", report });
        },
        (error: unknown) => {
          if (!mounted.current || operationGeneration !== generation.current) return;
          if (error instanceof ClientApiError && error.code === "IMPORT_PREVIEW_NOT_FOUND") {
            transition({ stage: "select", error: missingPreviewError(error) });
            return;
          }
          transition({
            stage: "preview",
            filename: current.filename,
            preview: current.preview,
            policy,
            error: publicError(error, "导入提交失败，请重试"),
          });
        },
      )
      .finally(() => {
        if (commitOperation.current === operation) commitOperation.current = null;
      });
    return operation.promise;
  }, [transition]);

  return { state, selectFile, setPolicy, commit, reset };
}
