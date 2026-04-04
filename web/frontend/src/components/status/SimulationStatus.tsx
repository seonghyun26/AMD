"use client";

import { useSessionStore } from "@/store/sessionStore";
import { Activity } from "lucide-react";

export default function SimulationStatus({
  runStatus = "standby",
  exitCode = null,
  progress,
  totalSteps = 0,
}: {
  runStatus?: "standby" | "running" | "finished" | "failed";
  exitCode?: number | null;
  progress?: { step: number; time_ps: number; ns_per_day: number } | null;
  totalSteps?: number;
}) {
  const simProgress = useSessionStore((s) => s.simProgress);
  const src = progress
    ? {
        step: progress.step,
        totalSteps,
        nsPerDay: progress.ns_per_day,
        timePs: progress.time_ps,
      }
    : simProgress;

  if (runStatus === "finished") {
    return (
      <div className="p-4 text-center text-emerald-600 dark:text-emerald-300">
        <Activity size={24} className="mx-auto mb-2 opacity-70" />
        <p className="text-sm">MD simulation finished</p>
      </div>
    );
  }

  if (runStatus === "failed") {
    return (
      <div className="p-4 text-center text-red-600 dark:text-red-300">
        <Activity size={24} className="mx-auto mb-2 opacity-70" />
        <p className="text-sm">MD simulation failed{exitCode !== null ? ` (exit ${exitCode})` : ""}</p>
      </div>
    );
  }

  if (!src || runStatus === "standby") return null;

  const step = Number.isFinite(src.step) ? src.step : 0;
  const total = Number.isFinite(src.totalSteps) ? src.totalSteps : 0;
  const nsPerDay = Number.isFinite(src.nsPerDay) ? src.nsPerDay : 0;
  const timePs = Number.isFinite(src.timePs) ? src.timePs : 0;

  const pct = total > 0
    ? Math.min(100, (step / total) * 100)
    : 0;
  const timeNs = timePs / 1000;

  const eta = nsPerDay > 0
    ? ((total - step) * 0.002 / 1000 / nsPerDay * 24)
    : null;

  return (
    <div className="p-4 space-y-4">
      <h3 className="text-sm font-semibold flex items-center gap-2">
        <Activity size={14} className="text-green-500" />
        Simulation Running
      </h3>

      {/* Progress bar */}
      <div>
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>{step.toLocaleString()} steps</span>
          <span>{pct.toFixed(1)}%</span>
        </div>
        <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2">
          <p className="text-xs text-gray-400">Time</p>
          <p className="text-sm font-mono font-medium">{timeNs.toFixed(3)} ns</p>
        </div>
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2">
          <p className="text-xs text-gray-400">Performance</p>
          <p className="text-sm font-mono font-medium">{nsPerDay.toFixed(2)} ns/day</p>
        </div>
        {eta !== null && (
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2 col-span-2">
            <p className="text-xs text-gray-400">ETA</p>
            <p className="text-sm font-mono font-medium">
              {eta < 1 ? `${(eta * 60).toFixed(0)} min` : `${eta.toFixed(1)} hr`}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
