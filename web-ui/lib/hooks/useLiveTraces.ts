"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ExecutionTraceItem } from "@/components/ExecutionTrace";

export interface UseLiveTracesOptions {
  /**
   * Optional predicate checked when `selectedThreadId` changes to a non-null ID.
   * When it returns `true`, the hook skips clearing traces for that transition
   * (used when auto-creating a thread mid-turn so live traces are preserved).
   */
  shouldSkipClear?: (threadId: string) => boolean;
}

export interface UseLiveTracesResult {
  traces: ExecutionTraceItem[];
  updateTraces: (newTraces: ExecutionTraceItem[]) => void;
  clearTraces: () => void;
}

export function useLiveTraces(
  selectedThreadId: string | null,
  options?: UseLiveTracesOptions
): UseLiveTracesResult {
  const [traces, setTraces] = useState<ExecutionTraceItem[]>([]);
  const shouldSkipClearRef = useRef(options?.shouldSkipClear);
  shouldSkipClearRef.current = options?.shouldSkipClear;

  const updateTraces = useCallback((newTraces: ExecutionTraceItem[]) => {
    setTraces(newTraces);
  }, []);

  const clearTraces = useCallback(() => {
    setTraces([]);
  }, []);

  useEffect(() => {
    if (!selectedThreadId) {
      setTraces([]);
      return;
    }
    if (shouldSkipClearRef.current?.(selectedThreadId)) {
      return;
    }
    setTraces([]);
  }, [selectedThreadId]);

  return {
    traces,
    updateTraces,
    clearTraces,
  };
}
