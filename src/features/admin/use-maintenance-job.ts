"use client";

import { useEffect, useRef, useState } from "react";

import { ClientApiError } from "@/lib/api-client";

import type { MaintenanceJobStatus, MaintenanceState } from "./types";

const terminalStates = new Set<MaintenanceState>([
  "ready",
  "awaiting-confirmation",
  "succeeded",
  "failed",
  "intervention-required",
]);

export type MaintenanceJobError = {
  message: string;
  status?: number;
  code?: string;
  requestId?: string;
  retryAfterSeconds?: number;
};

export type GetMaintenanceJob = (
  jobId: string,
  signal?: AbortSignal,
) => Promise<MaintenanceJobStatus>;

export function useMaintenanceJob(
  jobId: string | null,
  request: GetMaintenanceJob,
  generation = 0,
): {
  job: MaintenanceJobStatus | null;
  error: MaintenanceJobError | null;
  disconnected: boolean;
  recoveryGeneration: number;
} {
  const [job, setJob] = useState<MaintenanceJobStatus | null>(null);
  const [error, setError] = useState<MaintenanceJobError | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [recoveryGeneration, setRecoveryGeneration] = useState(0);
  const [resultKey, setResultKey] = useState("");
  const requestRef = useRef(request);
  const currentKey = jobId ? `${jobId}:${generation}` : "";

  useEffect(() => {
    requestRef.current = request;
  }, [request]);

  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    let controller: AbortController | null = null;
    let inFlight = false;

    if (!jobId) return;

    const interval = () => document.visibilityState === "hidden" ? 5_000 : 1_000;
    const clearTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };
    const schedule = (delay = interval()) => {
      clearTimer();
      timer = window.setTimeout(() => {
        timer = null;
        void poll();
      }, delay);
    };
    const poll = async () => {
      if (!alive || inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const next = await requestRef.current(jobId, controller.signal);
        if (!alive) return;
        setResultKey(currentKey);
        setJob(next);
        setError(null);
        setDisconnected(false);
        if (!terminalStates.has(next.state)) schedule();
      } catch (caught) {
        if (!alive || (caught instanceof Error && caught.name === "AbortError")) return;
        if (caught instanceof ClientApiError) {
          setResultKey(currentKey);
          setError({
            message: caught.message,
            status: caught.status,
            code: caught.code,
            requestId: caught.requestId,
            retryAfterSeconds: caught.retryAfterSeconds,
          });
          setDisconnected(false);
          if (caught.status === 401) setRecoveryGeneration((value) => value + 1);
          schedule((caught.retryAfterSeconds ?? 1) * 1_000);
        } else if (caught instanceof TypeError) {
          setResultKey(currentKey);
          setError({ message: "与服务器的连接暂时中断" });
          setDisconnected(true);
          setRecoveryGeneration((value) => value + 1);
          schedule();
        } else {
          setResultKey(currentKey);
          setError({ message: "读取维护任务状态失败" });
          setDisconnected(false);
          schedule();
        }
      } finally {
        inFlight = false;
        controller = null;
      }
    };
    const handleVisibility = () => {
      if (!inFlight && timer !== null) schedule();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    void poll();
    return () => {
      alive = false;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [currentKey, jobId]);

  return resultKey === currentKey
    ? { job, error, disconnected, recoveryGeneration }
    : { job: null, error: null, disconnected: false, recoveryGeneration: 0 };
}
