"use client";

import React from "react";
import { ShieldCheck, Lock, HardDrive, Cpu, UserCheck, Zap, Activity } from "lucide-react";

interface SandboxGaugeProps {
  securityPosture?: {
    execution_uid: string;
    root_filesystem: string;
    capabilities: string;
    tmpfs_buffer: string;
    provenance_level: string;
  };
}

export function SandboxGauge({ securityPosture }: SandboxGaugeProps) {
  const securityRules = [
    {
      title: "Network Egress",
      value: "Zero Egress (air-gapped)",
      detail: "ai-mesh (internal: true)",
      icon: Lock,
      status: "enforced",
      accent: "text-cyan-600 dark:text-cyan-400 bg-cyan-50 dark:bg-cyan-950/40 border-cyan-200 dark:border-cyan-500/20"
    },
    {
      title: "Root Filesystem",
      value: "Read-Only Enforced",
      detail: "read_only: true",
      icon: HardDrive,
      status: "enforced",
      accent: "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-500/20"
    },
    {
      title: "Linux Capabilities",
      value: "cap_drop: ALL",
      detail: "no-new-privileges: true",
      icon: ShieldCheck,
      status: "enforced",
      accent: "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-500/20"
    },
    {
      title: "Execution User",
      value: securityPosture?.execution_uid || "10001:10001",
      detail: "Unprivileged non-root",
      icon: UserCheck,
      status: "enforced",
      accent: "text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-500/20"
    },
    {
      title: "Ephemeral Buffer",
      value: "/tmp (tmpfs: 64MB)",
      detail: "rw,noexec,nosuid",
      icon: Zap,
      status: "enforced",
      accent: "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-500/20"
    },
    {
      title: "Supply-Chain Trust",
      value: securityPosture?.provenance_level || "SLSA-3 Verified",
      detail: "SPDX 2.3 SBOM Validated",
      icon: Activity,
      status: "enforced",
      accent: "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-500/20"
    }
  ];

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 sm:p-5 space-y-4 shadow-sm">
      {/* Header with Score */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 tracking-tight">
            Sandbox Isolation Matrix
          </h3>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/80 border border-emerald-300 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300 text-xs font-mono font-medium">
          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          100% ZERO-TRUST
        </div>
      </div>

      {/* Grid of Security Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {securityRules.map((rule, i) => {
          const IconComponent = rule.icon;
          return (
            <div
              key={i}
              className="p-3 rounded-xl bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700 transition-colors flex items-start gap-3"
            >
              <div className={`p-2 rounded-lg border shrink-0 ${rule.accent}`}>
                <IconComponent className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-mono text-slate-500 dark:text-zinc-400 uppercase tracking-wider">
                  {rule.title}
                </div>
                <div className="text-xs font-semibold text-slate-900 dark:text-zinc-100 truncate mt-0.5">
                  {rule.value}
                </div>
                <div className="text-[10px] font-mono text-slate-500 dark:text-zinc-400 truncate mt-0.5">
                  {rule.detail}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
