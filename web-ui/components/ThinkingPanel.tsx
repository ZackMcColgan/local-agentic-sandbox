import React, { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Map,
  Cog,
  CheckCircle2,
  Sparkles,
  MoreHorizontal
} from "lucide-react";

export type ThinkingPhaseKey = "planning" | "building" | "validating";

export interface ThinkingPhaseCardData {
  phase: ThinkingPhaseKey;
  title: string;
  timestamp: string;
  timeAgo?: string;
  narrative: string;
  status: "complete" | "in_progress" | "pending";
  progressPercent: number;
}

interface ThinkingPanelProps {
  phases?: ThinkingPhaseCardData[];
  rawThought?: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  onToggleExpand?: () => void;
  className?: string;
}

export function ThinkingPanel({
  phases = [],
  rawThought = "",
  isStreaming = false,
  defaultExpanded = true,
  className = ""
}: ThinkingPanelProps) {
  const [isExpanded, setIsExpanded] = useState<boolean>(defaultExpanded);

  // Group default phases if provided, or synthesize live reasoning card from rawThought
  const formattedTime = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const effectivePhases: ThinkingPhaseCardData[] = (() => {
    if (phases && phases.length > 0) return phases;

    if (rawThought && rawThought.trim()) {
      return [
        {
          phase: "planning",
          title: isStreaming ? "Reasoning in progress" : "Reasoning summary",
          timestamp: formattedTime,
          timeAgo: "Now",
          narrative: rawThought.trim(),
          status: isStreaming ? "in_progress" : "complete",
          progressPercent: isStreaming ? 85 : 100
        }
      ];
    }

    // Default 3-phase fallback when neither explicit phases nor raw thought are provided
    return [
      {
        phase: "planning",
        title: "Planning",
        timestamp: formattedTime,
        timeAgo: "Just now",
        narrative: "Broke the task into milestones. Scope evaluated. No unnecessary scaffolding.",
        status: isStreaming ? "in_progress" : "complete",
        progressPercent: isStreaming ? 85 : 100
      },
      {
        phase: "building",
        title: "Building",
        timestamp: formattedTime,
        timeAgo: "Now",
        narrative: "Generating clean deliverable markup and implementation code.",
        status: isStreaming ? "in_progress" : "complete",
        progressPercent: isStreaming ? 75 : 100
      },
      {
        phase: "validating",
        title: "Validating",
        timestamp: formattedTime,
        timeAgo: "Now",
        narrative: "Checking output compiles, adheres to constraints, and passes validation.",
        status: isStreaming ? "in_progress" : "complete",
        progressPercent: isStreaming ? 85 : 100
      }
    ];
  })();

  const activeStepsCount = effectivePhases.length;

  return (
    <div
      data-testid="thinking-panel"
      className={`w-full max-w-2xl rounded-3xl bg-[#1e1c24] dark:bg-[#15121b] border border-white/10 text-white shadow-xl overflow-hidden transition-all duration-200 ${className}`}
    >
      {/* Header bar matching wireframes/thinking-ui-mockup.webp */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/5 bg-[#262330]/60 backdrop-blur-md">
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-3 text-left group transition-transform focus:outline-none"
          aria-expanded={isExpanded}
        >
          <div className="w-8 h-8 rounded-xl bg-purple-900/60 text-purple-300 flex items-center justify-center border border-purple-500/20 group-hover:bg-purple-800/70 transition-colors">
            {isExpanded ? (
              <ChevronDown className="h-4 w-4 stroke-[2.5]" />
            ) : (
              <ChevronUp className="h-4 w-4 stroke-[2.5]" />
            )}
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-base font-semibold tracking-tight text-white group-hover:text-purple-200 transition-colors">
              Worker reasoning
            </span>
            <span
              data-testid="streaming-badge"
              className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-500/20 border border-purple-400/30 text-purple-200"
            >
              {isStreaming && <span className="h-1.5 w-1.5 rounded-full bg-purple-400 animate-pulse" />}
              <span>{isStreaming ? "Streaming" : "Complete"} · {activeStepsCount} {activeStepsCount === 1 ? "step" : "steps"}</span>
            </span>
          </div>
        </button>

        <div className="flex items-center gap-2 text-slate-400">
          <button
            type="button"
            className="p-1 rounded-lg hover:text-white hover:bg-white/10 transition-colors"
            title="Options"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Expanded Content: Phased Cards */}
      {isExpanded && (
        <div className="p-4 sm:p-5 space-y-3.5 bg-[#17141f]/90">
          {effectivePhases.map((phaseItem) => {
            const isPlanning = phaseItem.phase === "planning";
            const isBuilding = phaseItem.phase === "building";
            const isValidating = phaseItem.phase === "validating";

            const Icon = isPlanning ? Map : isBuilding ? Cog : CheckCircle2;
            const isCompleted = phaseItem.status === "complete";
            const isInProgress = phaseItem.status === "in_progress";

            return (
              <div
                key={phaseItem.phase}
                data-testid={`phase-card-${phaseItem.phase}`}
                className="p-4 rounded-2xl bg-[#231f2d] border border-white/5 space-y-3 shadow-sm hover:border-purple-500/20 transition-colors"
              >
                {/* Card Title & Meta */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-purple-900/40 text-purple-300 border border-purple-500/20 flex items-center justify-center shrink-0">
                      <Icon className="h-4 w-4 stroke-[2.2]" />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-white tracking-tight">
                        {phaseItem.title}
                      </h4>
                    </div>
                  </div>

                  <div className="text-right text-[11px] font-mono text-slate-400">
                    <span>{phaseItem.timestamp}</span>
                    {phaseItem.timeAgo && (
                      <span className="text-slate-500"> • {phaseItem.timeAgo}</span>
                    )}
                  </div>
                </div>

                {/* Narrative Text (Complete sentence, clean, no raw coordinates or code dump) */}
                <p className="text-xs text-slate-200 leading-relaxed font-sans pr-1">
                  {phaseItem.narrative}
                </p>

                {/* Per-phase Progress Bar & Status */}
                <div className="space-y-1.5 pt-1">
                  <div className="w-full h-1.5 bg-black/40 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        isCompleted
                          ? "bg-gradient-to-r from-purple-500 to-indigo-500"
                          : "bg-purple-500"
                      }`}
                      style={{ width: `${Math.min(Math.max(phaseItem.progressPercent, 5), 100)}%` }}
                    />
                  </div>

                  <div className="flex justify-end text-[11px] font-medium text-slate-400">
                    {isCompleted ? (
                      <span className="text-purple-300">Complete</span>
                    ) : isInProgress ? (
                      <span className="text-purple-300 font-semibold flex items-center gap-1">
                        <span>In progress · {phaseItem.progressPercent}%</span>
                      </span>
                    ) : (
                      <span className="text-slate-500">Pending</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Footer Status Pill matching Mockup */}
          <div className="pt-2 flex items-center gap-2 text-xs text-purple-300/90 font-medium">
            <Sparkles className="h-3.5 w-3.5 text-purple-400" />
            <span>
              {isStreaming
                ? "Reasoning in progress. Formulating structured execution..."
                : "Reasoning complete. Preparing final response..."}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
