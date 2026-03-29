"use client";

import { useState } from "react";
import {
  Activity,
  FlaskConical,
  Cpu,
  Zap,
  FileText,
  Loader2,
  CheckCircle2,
} from "lucide-react";

// ── Section card ─────────────────────────────────────────────────────

export function Section({
  icon,
  title,
  children,
  accent = "blue",
  action,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  accent?: "blue" | "indigo" | "emerald" | "amber";
  action?: React.ReactNode;
}) {
  const border = {
    blue: "border-blue-300/70 dark:border-blue-800/40",
    indigo: "border-indigo-300/70 dark:border-indigo-800/40",
    emerald: "border-emerald-300/70 dark:border-emerald-800/40",
    amber: "border-amber-300/70 dark:border-amber-800/40",
  }[accent];
  const iconBg = {
    blue: "bg-blue-100/60 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400",
    indigo: "bg-indigo-100/60 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400",
    emerald: "bg-emerald-100/60 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400",
    amber: "bg-amber-100/60 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400",
  }[accent];

  return (
    <div className={`rounded-xl border-2 ${border} bg-gray-50/80 dark:bg-gray-900/60 overflow-hidden`}>
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-gray-200/60 dark:border-gray-800/60">
        <span className={`p-1.5 rounded-md ${iconBg}`}>{icon}</span>
        <span className="text-sm font-semibold text-gray-600 dark:text-gray-400 tracking-wider uppercase">{title}</span>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <div className="p-4 space-y-3">{children}</div>
    </div>
  );
}

// ── Field ────────────────────────────────────────────────────────────

export function Field({
  label,
  value,
  onChange,
  onBlur,
  type = "text",
  step,
  unit,
  hint,
}: {
  label: string;
  value: string | number;
  onChange: (v: string | number) => void;
  onBlur?: () => void;
  type?: string;
  step?: string | number;
  unit?: string;
  hint?: string;
}) {
  const [draftNumberValue, setDraftNumberValue] = useState<string | null>(null);
  const isNumber = type === "number";
  const displayValue = isNumber ? (draftNumberValue ?? String(value ?? "")) : value;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-sm font-medium text-gray-600 dark:text-gray-400">{label}</label>
        {unit && (
          <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">
            {unit}
          </span>
        )}
      </div>
      <input
        type={type}
        value={displayValue}
        onChange={(e) => {
          if (isNumber) {
            const raw = e.currentTarget.value;
            setDraftNumberValue(raw);
            if (raw === "" || raw === "-" || raw === "." || raw === "-.") return;
            const n = Number(raw);
            if (!Number.isNaN(n)) onChange(n);
            return;
          }
          onChange(e.currentTarget.value);
        }}
        onBlur={() => {
          if (isNumber) setDraftNumberValue(null);
          onBlur?.();
        }}
        step={step ?? (type === "number" ? "any" : undefined)}
        className="w-full border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors"
      />
      {hint && <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-600">{hint}</p>}
    </div>
  );
}

// ── FieldGrid ────────────────────────────────────────────────────────

export function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

// ── SelectField ──────────────────────────────────────────────────────

export function SelectField({
  label,
  value,
  onChange,
  onSave,
  options,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSave?: () => void;
  options: { value: string; label: string }[];
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1.5">{label}</label>
      <select
        value={value}
        onChange={(e) => { onChange(e.target.value); onSave?.(); }}
        className="w-full border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {hint && <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-600">{hint}</p>}
    </div>
  );
}

// ── PillTabs ─────────────────────────────────────────────────────────

const TABS = [
  { value: "progress", label: "Progress", icon: <Activity size={14} /> },
  { value: "molecule", label: "Molecule", icon: <FlaskConical size={14} /> },
  { value: "gromacs",  label: "GROMACS",  icon: <Cpu size={14} /> },
  { value: "method",   label: "Method",   icon: <Zap size={14} /> },
  { value: "files",    label: "Files",    icon: <FileText size={14} /> },
];

export function PillTabs({
  active,
  onChange,
  saveState = "idle",
}: {
  active: string;
  onChange: (v: string) => void;
  saveState?: "idle" | "saving" | "saved";
}) {
  return (
    <div className="flex items-center gap-1 p-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
      {TABS.map(({ value, label, icon }) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            active === value
              ? "bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm"
              : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800/70"
          }`}
        >
          {icon}
          {label}
        </button>
      ))}
      <div className="ml-auto flex-shrink-0">
        {saveState === "saving" && (
          <span className="inline-flex items-center gap-1.5 text-xs text-blue-500 dark:text-blue-400 pr-2">
            <Loader2 size={12} className="animate-spin" />
            Saving
          </span>
        )}
        {saveState === "saved" && (
          <span className="inline-flex items-center gap-1.5 text-xs text-emerald-500 dark:text-emerald-400 pr-2">
            <CheckCircle2 size={12} />
            Saved
          </span>
        )}
      </div>
    </div>
  );
}
