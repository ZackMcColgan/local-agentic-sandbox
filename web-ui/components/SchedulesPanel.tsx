"use client";

import React, { useEffect, useState } from "react";
import { CalendarClock, Play, Pause, Trash2, Plus, RefreshCw } from "lucide-react";
import type { Schedule } from "@/lib/subagents/scheduler";
import type { DaemonHealthReport } from "@/app/api/scheduler/health/route";

export interface SchedulesPanelProps {
  initialSchedules?: Schedule[];
  initialHealth?: DaemonHealthReport | null;
}

export function SchedulesPanel({ initialSchedules, initialHealth }: SchedulesPanelProps) {
  const [schedules, setSchedules] = useState<Schedule[]>(initialSchedules || []);
  const [health, setHealth] = useState<DaemonHealthReport | null>(initialHealth ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [cronExpression, setCronExpression] = useState("0 2 * * *");
  const [taskDescription, setTaskDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadData = async () => {
    if (typeof window === "undefined") return;
    setLoading(true);
    setError(null);
    try {
      const [schedRes, healthRes] = await Promise.all([
        fetch("/api/schedules", { cache: "no-store" }),
        fetch("/api/scheduler/health", { cache: "no-store" }),
      ]);
      if (schedRes.ok) {
        const data = await schedRes.json();
        setSchedules(Array.isArray(data.schedules) ? data.schedules : []);
      } else {
        const errJson = await schedRes.json().catch(() => ({}));
        setError(errJson.error || `Failed to load schedules (${schedRes.status})`);
      }
      if (healthRes.ok) {
        const healthData = (await healthRes.json()) as DaemonHealthReport;
        setHealth(healthData);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!initialSchedules) {
      void loadData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cronExpression.trim() || !taskDescription.trim()) {
      setError("Cron expression and task description are required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setStatusMessage(null);
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cronExpression: cronExpression.trim(),
          taskDescription: taskDescription.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Failed to create schedule (${res.status})`);
        return;
      }
      setTaskDescription("");
      setStatusMessage("Schedule created.");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create schedule");
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (sched: Schedule) => {
    setBusyId(sched.id);
    setError(null);
    setStatusMessage(null);
    try {
      const res = await fetch(`/api/schedules/${encodeURIComponent(sched.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !sched.enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Failed to update schedule (${res.status})`);
        return;
      }
      if (data.schedule) {
        setSchedules((prev) => prev.map((s) => (s.id === sched.id ? data.schedule : s)));
      } else {
        await loadData();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update schedule");
    } finally {
      setBusyId(null);
    }
  };

  const handleTrigger = async (sched: Schedule) => {
    setBusyId(sched.id);
    setError(null);
    setStatusMessage(null);
    try {
      const res = await fetch(`/api/schedules/${encodeURIComponent(sched.id)}/trigger`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Failed to trigger schedule (${res.status})`);
        return;
      }
      setStatusMessage(`Triggered run ${data.runId || sched.id}.`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to trigger schedule");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (sched: Schedule) => {
    setBusyId(sched.id);
    setError(null);
    setStatusMessage(null);
    try {
      const res = await fetch(`/api/schedules/${encodeURIComponent(sched.id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Failed to delete schedule (${res.status})`);
        return;
      }
      setSchedules((prev) => prev.filter((s) => s.id !== sched.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete schedule");
    } finally {
      setBusyId(null);
    }
  };

  const healthLabel =
    health?.status === "healthy"
      ? "Daemon Healthy"
      : health?.status === "degraded"
        ? "Daemon Degraded"
        : "Daemon Not Running";

  return (
    <div
      data-testid="schedules-panel"
      className="bg-white dark:bg-[#0e0e12] rounded-3xl p-4 sm:p-5 surface-card border border-zinc-200 dark:border-zinc-800 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          <div>
            <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
              Scheduled Runs
            </h2>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              Cron schedules and background scheduler daemon health
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span
            data-testid="scheduler-health-badge"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${
              health?.status === "healthy"
                ? "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800"
                : health?.status === "degraded"
                  ? "bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-800"
                  : "bg-zinc-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 border-zinc-300 dark:border-zinc-700"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                health?.status === "healthy"
                  ? "bg-emerald-500"
                  : health?.status === "degraded"
                    ? "bg-rose-500"
                    : "bg-zinc-400"
              }`}
            />
            {healthLabel}
          </span>
          <button
            type="button"
            onClick={() => void loadData()}
            disabled={loading}
            aria-label="Refresh schedules"
            className="min-h-[36px] px-2.5 py-1 rounded-xl border border-zinc-200 dark:border-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors inline-flex items-center gap-1"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {error && (
        <div
          data-testid="schedules-error"
          className="rounded-xl border border-rose-300 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-xs text-rose-700 dark:text-rose-300"
        >
          {error}
        </div>
      )}

      {statusMessage && (
        <div className="rounded-xl border border-emerald-300 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          {statusMessage}
        </div>
      )}

      {/* Create Schedule Form */}
      <form
        onSubmit={handleCreate}
        className="grid grid-cols-1 sm:grid-cols-[140px_1fr_auto] gap-2 items-center"
      >
        <input
          type="text"
          value={cronExpression}
          onChange={(e) => setCronExpression(e.target.value)}
          placeholder="0 2 * * *"
          aria-label="Cron expression"
          className="px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black font-mono text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:border-emerald-500"
        />
        <input
          type="text"
          value={taskDescription}
          onChange={(e) => setTaskDescription(e.target.value)}
          placeholder="Task description (e.g. Run overnight regression suite)"
          aria-label="Schedule task description"
          className="px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:border-emerald-500"
        />
        <button
          type="submit"
          disabled={submitting}
          data-testid="schedule-create-btn"
          className="min-h-[38px] px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-black text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>{submitting ? "Adding…" : "Add Schedule"}</span>
        </button>
      </form>

      {/* Schedule List */}
      {schedules.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-800 p-4 text-center text-xs text-zinc-600 dark:text-zinc-400">
          No schedules configured yet.
        </div>
      ) : (
        <div className="space-y-2">
          {schedules.map((sched) => {
            const isBusy = busyId === sched.id;
            return (
              <div
                key={sched.id}
                data-testid={`schedule-row-${sched.id}`}
                className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-800 dark:text-zinc-200">
                      {sched.cronExpression}
                    </span>
                    <span
                      className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full border ${
                        sched.enabled
                          ? "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800"
                          : "bg-zinc-200 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-400 border-zinc-300 dark:border-zinc-700"
                      }`}
                    >
                      {sched.enabled ? "Enabled" : "Paused"}
                    </span>
                    {typeof sched.failureCount === "number" && sched.failureCount > 0 && (
                      <span className="text-[10.5px] font-mono text-rose-700 dark:text-rose-300">
                        {sched.failureCount} failure{sched.failureCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 break-words">
                    {sched.taskDescription}
                  </div>
                  <div className="text-[11px] font-mono text-zinc-600 dark:text-zinc-400">
                    Next: {sched.nextRun ? new Date(sched.nextRun).toLocaleString() : "Unscheduled"}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    data-testid={`schedule-trigger-${sched.id}`}
                    disabled={isBusy || !sched.enabled}
                    onClick={() => void handleTrigger(sched)}
                    title={sched.enabled ? "Trigger run now" : "Enable schedule before triggering"}
                    className="min-h-[36px] px-2.5 py-1 rounded-xl bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-black text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-40 transition-colors"
                  >
                    <Play className="h-3 w-3" />
                    <span>Trigger</span>
                  </button>
                  <button
                    type="button"
                    data-testid={`schedule-toggle-${sched.id}`}
                    disabled={isBusy}
                    onClick={() => void handleToggle(sched)}
                    className="min-h-[36px] px-2.5 py-1 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-40 transition-colors"
                  >
                    {sched.enabled ? (
                      <>
                        <Pause className="h-3 w-3" />
                        <span>Pause</span>
                      </>
                    ) : (
                      <>
                        <Play className="h-3 w-3" />
                        <span>Resume</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    data-testid={`schedule-delete-${sched.id}`}
                    disabled={isBusy}
                    onClick={() => void handleDelete(sched)}
                    aria-label={`Delete schedule ${sched.id}`}
                    className="min-h-[36px] px-2.5 py-1 rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/60 text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-40 transition-colors"
                  >
                    <Trash2 className="h-3 w-3" />
                    <span>Delete</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
