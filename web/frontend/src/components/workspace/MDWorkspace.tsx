"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Settings,
  Cpu,
  Zap,
  FlaskConical,
  Play,
  Pause,
  Square,
  Loader2,
  Plus,
  RefreshCw,
  Eye,
  Upload,
  CheckCircle2,
  FileText,
  Thermometer,
  Gauge,
  Mountain,
  Binary,
  Layers,
  MessageSquare,
  Bot,
  Download,
  Trash2,
  ChevronDown,
  ChevronRight,
  X,
  Archive,
  RotateCcw,
  Lock,
  Search,
} from "lucide-react";

const AgentModal = dynamic(() => import("@/components/agents/AgentModal"), { ssr: false });
import type { AgentType } from "@/lib/agentStream";
import { getUsername } from "@/lib/auth";
import dynamic from "next/dynamic";
const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });
const TrajectoryViewer = dynamic(() => import("@/components/viz/TrajectoryViewer"), { ssr: false });
const MoleculeViewer = dynamic(() => import("@/components/viz/MoleculeViewer"), { ssr: false });
const MiniStructureViewer = dynamic(() => import("@/components/viz/MiniStructureViewer"), { ssr: false });
const CVSetupModal = dynamic(() => import("@/components/viz/CVSetupModal"), { ssr: false });
const InlineCVPicker = dynamic(() => import("@/components/viz/InlineCVPicker"), { ssr: false });
const CustomCVResultCard = dynamic(() => import("@/components/viz/CustomCVResultCard"), { ssr: false });
import FileUpload from "@/components/files/FileUpload";
import {
  getSessionConfig,
  updateSessionConfig,
  generateSessionFiles,
  listFiles,
  downloadUrl,
  downloadZipUrl,
  getFileContent,
  deleteFile,
  listArchiveFiles,
  restoreFile,
  createSession,
  updateSessionMolecule,
  startSimulation,
  getSimulationStatus,
  getProgress,
  stopSimulation,
  terminateSimulation,
  resumeSimulation,
  checkCheckpoint,
  getEnergy,
  getRamachandranImageUrl,
  type RamachandranPlotSettings,
  updateResultCards,
  type CustomCVConfig,
  getSessionRunStatus,
  getAvailableGpu,
  getPlumedPreview,
  generatePlumedFile,
  getMolecules,
  loadMolecule,
  validateCheckpoint,
} from "@/lib/api";
import { useSessionStore } from "@/store/sessionStore";

// ── Helpers ───────────────────────────────────────────────────────────

/** Generate a UUID, with fallback for non-HTTPS / older browsers. */
function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: random hex string
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Shorten an error for UI display — keep first line only, trim paths to filename. */
function briefError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Take only the first line
  let msg = raw.split("\n")[0].trim();
  // Collapse absolute paths to just the filename
  msg = msg.replace(/(?:\/[\w.\-/]+\/)([\w.\-]+)/g, "$1");
  // Cap length
  if (msg.length > 120) msg = msg.slice(0, 117) + "…";
  return msg || "Unknown error";
}

function defaultNickname(): string {
  const now = new Date();
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const DD = String(now.getDate()).padStart(2, "0");
  const HH = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const SS = String(now.getSeconds()).padStart(2, "0");
  return `${MM}${DD}-${HH}${mm}${SS}`;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ── Presets ───────────────────────────────────────────────────────────

interface Preset { id: string; label: string; description: string; tag: string }

const PRESETS: Preset[] = [
  { id: "md",       label: "Molecular Dynamics", description: "Unbiased MD — no enhanced sampling",             tag: "MD"      },
  { id: "metad",    label: "Metadynamics",        description: "Well-tempered metadynamics with PLUMED",        tag: "MetaD"   },
  { id: "opes",     label: "OPES Metadynamics",   description: "On-the-fly probability enhanced sampling",      tag: "OPES"    },
  { id: "umbrella", label: "Umbrella Sampling",   description: "Umbrella sampling along a reaction coordinate", tag: "US"      },
  { id: "steered",  label: "Steered MD",           description: "Steered MD with moving restraint",              tag: "SMD"     },
];

// ── System options ─────────────────────────────────────────────────────

interface SystemOption { id: string; label: string; description: string }

const SYSTEMS: SystemOption[] = [
  { id: "ala_dipeptide", label: "Alanine Dipeptide",  description: "Blocked alanine dipeptide · Ace-Ala-Nme" },
  { id: "chignolin",     label: "Chignolin (CLN025)", description: "10-residue β-hairpin mini-protein"        },
  { id: "blank",         label: "Blank",              description: "No system — configure manually"           },
];

// Maps system config name → human label for the molecule pane header
const SYSTEM_LABELS: Record<string, string> = {
  ala_dipeptide: "Alanine Dipeptide",
  protein:       "Protein",
  membrane:      "Membrane",
  chignolin:     "Chignolin",
};

// ── GROMACS templates ──────────────────────────────────────────────────

interface GmxTemplate { id: string; label: string; description: string }

const GMX_TEMPLATES: GmxTemplate[] = [
  { id: "vacuum", label: "Vacuum", description: "Dodecahedron vacuum box · no solvent · fast" },
  { id: "auto",   label: "Auto",   description: "Maximally compatible defaults · PME · solvated" },
  { id: "tip3p",  label: "TIP3P",  description: "Explicit TIP3P water · PME · NPT ensemble" },
];

// ── UI primitives ─────────────────────────────────────────────────────

/** Section card with a header label and icon */
function Section({
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

/** Labelled number / text input with optional unit badge and hint */
function Field({
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
            // Allow temporary editing states; only commit valid numeric values.
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

/** Two-column grid for related fields */
function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

/** Labelled select dropdown */
function SelectField({
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


// ── Pill tab bar ──────────────────────────────────────────────────────

const TABS = [
  { value: "progress", label: "Progress", icon: <Activity size={14} /> },
  { value: "molecule", label: "Molecule", icon: <FlaskConical size={14} /> },
  { value: "gromacs",  label: "GROMACS",  icon: <Cpu size={14} /> },
  { value: "method",   label: "Method",   icon: <Zap size={14} /> },
  { value: "files",    label: "Files",    icon: <FileText size={14} /> },
];

function PillTabs({
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
      {/* Save state indicator — right side */}
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

// ── Mol file helper ────────────────────────────────────────────────────

const MOL_EXTS = new Set(["pdb", "gro", "mol2", "xyz", "sdf"]);
function isMolFile(path: string) {
  return MOL_EXTS.has(path.split(".").pop()?.toLowerCase() ?? "");
}

const STATIC_DERIVED_MOL_NAMES = new Set(["system.gro", "box.gro", "solvated.gro", "ionized.gro"]);

function fileBaseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function rootStem(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function expectedDerivedNames(rootName: string): string[] {
  const stem = rootStem(rootName);
  return [
    `${stem}_system.gro`,
    `${stem}_box.gro`,
    `${stem}_solvated.gro`,
    `${stem}_ionized.gro`,
  ];
}

function isDerivedMolName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    STATIC_DERIVED_MOL_NAMES.has(n)
    || n.endsWith("_system.gro")
    || n.endsWith("_box.gro")
    || n.endsWith("_solvated.gro")
    || n.endsWith("_ionized.gro")
  );
}

type MolTreeNode = {
  path: string;
  name: string;
  isDerived: boolean;
};

type MolTreeGroup = {
  root: MolTreeNode;
  children: MolTreeNode[];
};

function buildMolTreeGroups(molFiles: string[], originHint: string): MolTreeGroup[] {
  const byName = new Map<string, string>();
  for (const p of molFiles) byName.set(fileBaseName(p), p);

  const roots = molFiles
    .filter((p) => !isDerivedMolName(fileBaseName(p)))
    .sort((a, b) => fileBaseName(a).localeCompare(fileBaseName(b)));

  const hintName = fileBaseName(originHint || "");
  const activeRoot = roots.find((r) => fileBaseName(r) === hintName) ?? roots[0] ?? "";

  const groups: MolTreeGroup[] = [];
  for (const rootPath of roots) {
    const rootName = fileBaseName(rootPath);
    const children: MolTreeNode[] = [];

    const derivedNames = expectedDerivedNames(rootName);
    for (let i = 0; i < derivedNames.length; i++) {
      const dn = derivedNames[i];
      const dp = byName.get(dn);
      if (dp) children.push({ path: dp, name: dn, isDerived: true });
    }
    groups.push({ root: { path: rootPath, name: rootName, isDerived: false }, children });
  }

  // If we only have derived files (no original root), show a readable fallback chain.
  if (groups.length === 0) {
    const preferred = [hintName, "system.gro", "box.gro", "solvated.gro", "ionized.gro"];
    const present = preferred
      .concat(Array.from(byName.keys()).sort())
      .filter((n, idx, arr) => byName.has(n) && arr.indexOf(n) === idx);
    if (present.length > 0) {
      const rootName = present[0];
      groups.push({
        root: { path: byName.get(rootName)!, name: rootName, isDerived: false },
        children: present.slice(1).map((n) => ({ path: byName.get(n)!, name: n, isDerived: true })),
      });
    }
  }

  // Move active root block first for faster scanning.
  if (activeRoot) {
    const activeRootName = fileBaseName(activeRoot);
    const ordered: MolTreeGroup[] = [];
    const rest: MolTreeGroup[] = [];
    for (const g of groups) {
      (g.root.name === activeRootName ? ordered : rest).push(g);
    }
    return [...ordered, ...rest];
  }

  return groups;
}

// ── File preview helpers ────────────────────────────────────────────────

const _BINARY_EXTS = new Set([".xtc", ".trr", ".edr", ".tpr", ".cpt", ".xdr", ".dms", ".gsd"]);

function canPreview(name: string): "text" | "binary" {
  const ext = "." + (name.split(".").pop() ?? "").toLowerCase();
  if (_BINARY_EXTS.has(ext)) return "binary";
  return "text";
}

// ── File preview modal ─────────────────────────────────────────────────

function FilePreviewModal({
  sessionId,
  path,
  onClose,
}: {
  sessionId: string;
  path: string;
  onClose: () => void;
}) {
  const name = path.split("/").pop() ?? path;
  const kind = canPreview(name);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(kind !== "binary");

  useEffect(() => {
    if (kind === "binary") return;
    setLoading(true);
    getFileContent(sessionId, path)
      .then((text) => setContent(text.length > 200_000 ? text.slice(0, 200_000) + "\n…[truncated]" : text))
      .catch((e) => setContent(`Error loading file: ${e}`))
      .finally(() => setLoading(false));
  }, [sessionId, path, kind]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl flex flex-col shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden"
        style={{ width: "min(900px, 92vw)", height: "80vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <span className="text-sm font-mono text-gray-800 dark:text-gray-200 truncate">{name}</span>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a
              href={downloadUrl(sessionId, path)}
              download={name}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <Download size={12} />
              Download
            </a>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden">
          {kind === "binary" ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-gray-500">
              <FileText size={32} className="opacity-30" />
              <p className="text-sm">Binary file — cannot preview.</p>
              <a
                href={downloadUrl(sessionId, path)}
                download={name}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white text-sm transition-colors"
              >
                <Download size={13} /> Download
              </a>
            </div>
          ) : loading ? (
            <div className="h-full flex items-center justify-center text-gray-500">
              <Loader2 size={20} className="animate-spin mr-2" />
              <span className="text-sm">Loading…</span>
            </div>
          ) : (
            <pre className="h-full overflow-auto p-4 text-[11px] font-mono text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap break-all bg-gray-50 dark:bg-gray-950">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Delete confirmation popup ──────────────────────────────────────────

function DeleteConfirmPopup({
  name,
  onConfirm,
  onCancel,
}: {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onCancel}>
      <div
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl p-5 w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-1">Move to archive?</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          <span className="font-mono text-gray-700 dark:text-gray-300">{name}</span> will be moved to the session&apos;s
          archive folder. You can recover it manually.
        </p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-50 dark:bg-red-900/60 hover:bg-red-100 dark:hover:bg-red-800/70 border border-red-300/60 dark:border-red-700/60 text-red-600 dark:text-red-300 hover:text-red-700 dark:hover:text-red-100 transition-colors"
          >
            Move to archive
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Results section sub-components ────────────────────────────────────

type ResultCardType = "energy_potential" | "energy_kinetic" | "energy_total" | "energy_temperature" | "energy_pressure" | "ramachandran" | "custom_cv";
interface ResultCardDef { id: string; type: ResultCardType; meta?: CustomCVConfig }

type EnergyCardType = Exclude<ResultCardType, "ramachandran" | "custom_cv">;
const ENERGY_TERM_CONFIG: Record<EnergyCardType, { label: string; xvgPrefix: string; unit: string; color: string; fillColor: string }> = {
  energy_potential:    { label: "Potential Energy", xvgPrefix: "potential",   unit: "kJ/mol", color: "#f59e0b", fillColor: "rgba(245,158,11,0.10)"  },
  energy_kinetic:      { label: "Kinetic Energy",   xvgPrefix: "kinetic",     unit: "kJ/mol", color: "#38bdf8", fillColor: "rgba(56,189,248,0.10)"  },
  energy_total:        { label: "Total Energy",     xvgPrefix: "total",       unit: "kJ/mol", color: "#a78bfa", fillColor: "rgba(167,139,250,0.10)" },
  energy_temperature:  { label: "Temperature",      xvgPrefix: "temperature", unit: "K",      color: "#f87171", fillColor: "rgba(248,113,113,0.10)" },
  energy_pressure:     { label: "Pressure",         xvgPrefix: "pressure",    unit: "bar",    color: "#34d399", fillColor: "rgba(52,211,153,0.10)"  },
};

const ENERGY_CARD_TYPES: EnergyCardType[] = [
  "energy_potential", "energy_kinetic", "energy_total", "energy_temperature", "energy_pressure",
];

const VALID_RESULT_CARD_TYPES = new Set<string>([...ENERGY_CARD_TYPES, "ramachandran", "custom_cv"]);


/** Write a 2-column float64 numpy array [time, value] and trigger a browser download. */
function downloadNpy(times: number[], values: number[], filename: string) {
  const N = Math.min(times.length, values.length);
  const floatData = new Float64Array(N * 2);
  for (let i = 0; i < N; i++) { floatData[i * 2] = times[i]; floatData[i * 2 + 1] = values[i]; }
  const magic   = new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]);
  const version = new Uint8Array([0x01, 0x00]);
  const headerDict = `{'descr': '<f8', 'fortran_order': False, 'shape': (${N}, 2), }`;
  const prefixLen = 10;
  const minTotal = prefixLen + headerDict.length + 1;
  const paddedTotal = Math.ceil(minTotal / 64) * 64;
  const headerLen = paddedTotal - prefixLen;
  const header = headerDict.padEnd(headerLen - 1, ' ') + '\n';
  const headerBytes = new TextEncoder().encode(header);
  const buf = new ArrayBuffer(paddedTotal + floatData.byteLength);
  const u8  = new Uint8Array(buf);
  const dv  = new DataView(buf);
  u8.set(magic, 0); u8.set(version, 6);
  dv.setUint16(8, headerLen, true);
  u8.set(headerBytes, 10);
  u8.set(new Uint8Array(floatData.buffer), paddedTotal);
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function EnergyCardContent({
  sessionId,
  type,
  compact,
  refreshKey = 0,
  maxPoints = 2000,
  onStats,
}: {
  sessionId: string;
  type: EnergyCardType;
  compact: boolean;
  refreshKey?: number;
  maxPoints?: number;
  onStats?: (stats: { last: number; min: number; max: number; mean: number }) => void;
}) {
  const [data, setData] = useState<Record<string, number[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [hasEdr, setHasEdr] = useState(false);
  const prevRefreshKeyRef = useRef(refreshKey);
  const cfg = ENERGY_TERM_CONFIG[type];

  useEffect(() => {
    const isRefresh = refreshKey !== 0 && refreshKey !== prevRefreshKeyRef.current;
    prevRefreshKeyRef.current = refreshKey;
    let cancelled = false;
    setLoading(true);
    setData(null);
    setHasEdr(false);

    (async () => {
      try {
        // Step 1: try cache first (fast, no gmx needed)
        const cached = await getEnergy(sessionId, { maxPoints });
        if (cancelled) return;
        if (cached.available) {
          setData(cached.data);
          setLoading(false);
          return;
        }
        setHasEdr(cached.has_edr ?? false);

        // Step 2: if refresh was clicked and .edr exists, extract via gmx energy
        if (isRefresh && cached.has_edr) {
          setExtracting(true);
          const extracted = await getEnergy(sessionId, { extract: true, maxPoints });
          if (cancelled) return;
          if (extracted.available) setData(extracted.data);
          setExtracting(false);
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [sessionId, refreshKey, maxPoints]);

  const handleExtract = async () => {
    setExtracting(true);
    try {
      const result = await getEnergy(sessionId, { extract: true, maxPoints });
      if (result.available) setData(result.data);
    } catch { /* ignore */ }
    setExtracting(false);
  };

  // Notify parent of stats when data is available — must run unconditionally (Rules of Hooks)
  useEffect(() => {
    if (loading || !data) return;
    const xVals = data.time_ps ?? data.step ?? [];
    const dataKey = Object.keys(data).find((k) =>
      k.toLowerCase().replace(/[-.\s]/g, "").startsWith(cfg.xvgPrefix.replace(/[-.\s]/g, ""))
    );
    if (!dataKey || xVals.length === 0) return;
    const yVals = data[dataKey];
    const lastVal = yVals[yVals.length - 1] ?? 0;
    let minVal = Infinity, maxVal = -Infinity, sumVal = 0;
    for (const v of yVals) { if (v < minVal) minVal = v; if (v > maxVal) maxVal = v; sumVal += v; }
    const meanVal = yVals.length > 0 ? sumVal / yVals.length : 0;
    onStats?.({ last: lastVal, min: minVal, max: maxVal, mean: meanVal });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, loading, sessionId, cfg.xvgPrefix]);

  if (loading || extracting) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-500">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-xs">{extracting ? "Running gmx energy…" : "Loading energy data…"}</span>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-500">
        {hasEdr ? (
          <>
            <span className="text-xs text-gray-400 dark:text-gray-600 px-3 text-center">Energy data not yet extracted.</span>
            <button onClick={handleExtract} className="text-xs text-blue-500 hover:text-blue-400 transition-colors">
              Run gmx energy
            </button>
          </>
        ) : (
          <span className="text-xs text-gray-400 dark:text-gray-600 px-3 text-center">No .edr file found.</span>
        )}
      </div>
    );
  }

  const xVals = data.time_ps ?? data.step ?? [];
  // Fuzzy-match the XVG legend key by prefix (handles "Kinetic-En." vs "Kinetic")
  const dataKey = Object.keys(data).find(
    (k) => k.toLowerCase().replace(/[-.\s]/g, "").startsWith(cfg.xvgPrefix.replace(/[-.\s]/g, ""))
  );

  if (!dataKey || xVals.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-500">
        <span className="text-xs text-gray-400 dark:text-gray-600 px-3 text-center">Term not found in energy file.</span>
      </div>
    );
  }

  const yVals = data[dataKey];
  const lastVal = yVals[yVals.length - 1] ?? 0;
  let minVal = Infinity, maxVal = -Infinity, sumVal = 0;
  for (const v of yVals) { if (v < minVal) minVal = v; if (v > maxVal) maxVal = v; sumVal += v; }
  const meanVal = yVals.length > 0 ? sumVal / yVals.length : 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const axisBase: any = {
    zeroline: false,
    color: "#374151",
    tickfont: { size: compact ? 10 : 11, color: "#6b7280" },
    titlefont: { size: 12, color: cfg.color },
    gridcolor: "#1f2937",
    gridwidth: 1,
    showgrid: true,
  };

  return (
    <Plot
      data={[{
        type: "scatter",
        mode: "lines",
        x: xVals,
        y: yVals,
        name: cfg.label,
        fill: "tozeroy",
        fillcolor: cfg.fillColor,
        line: { color: cfg.color, width: compact ? 2 : 2.5, shape: "spline", smoothing: 0.3 },
      }]}
      layout={{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        xaxis: { ...axisBase, title: compact ? undefined : ("Time (ps)" as any), nticks: compact ? 5 : 8 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        yaxis: { ...axisBase, title: cfg.unit as any, nticks: compact ? 5 : 6 },
        showlegend: false,
        hovermode: "x unified",
        hoverlabel: { bgcolor: "#111827", bordercolor: cfg.color, font: { size: 12, color: "#e5e7eb" } },
        margin: compact ? { t: 4, l: 50, r: 6, b: 30 } : { t: 8, l: 56, r: 20, b: 40 },
        paper_bgcolor: "transparent",
        plot_bgcolor: "transparent",
      }}
      config={{ responsive: true, displayModeBar: false }}
      style={{ width: "100%", height: "100%" }}
    />
  );
}

function ResultCard({
  card,
  sessionId,
  onDelete,
}: {
  card: ResultCardDef;
  sessionId: string;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [stats, setStats] = useState<{ last: number; min: number; max: number; mean: number } | null>(null);
  const termCfg = ENERGY_TERM_CONFIG[card.type as EnergyCardType];
  const label = termCfg?.label ?? card.type;
  const accentColor = termCfg?.color ?? "#6b7280";
  const unit = termCfg?.unit ?? "";

  const handleRefresh = () => {
    setRefreshKey((k) => k + 1);
    setStats(null);
    setSpinning(true);
    setTimeout(() => setSpinning(false), 800);
  };

  const fmtVal = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 1e4 || (abs < 0.01 && abs > 0)) return v.toExponential(2);
    return v.toFixed(abs >= 100 ? 1 : 2);
  };

  const handleDownload = async () => {
    if (!termCfg) return;
    try {
      const result = await getEnergy(sessionId, { extract: true, maxPoints: 100000 });
      if (!result.available) return;
      const xVals = result.data.time_ps ?? result.data.step ?? [];
      const dataKey = Object.keys(result.data).find((k) =>
        k.toLowerCase().replace(/[-.\s]/g, "").startsWith(termCfg.xvgPrefix.replace(/[-.\s]/g, ""))
      );
      if (!dataKey || xVals.length === 0) return;
      downloadNpy(
        Array.from(xVals as number[]),
        Array.from(result.data[dataKey] as number[]),
        `${termCfg.xvgPrefix}.npy`
      );
    } catch { /* silently ignore */ }
  };

  if (card.type === "ramachandran") {
    return <RamachandranResultCard sessionId={sessionId} onDelete={onDelete} />;
  }

  if (card.type === "custom_cv" && card.meta) {
    return <CustomCVResultCard sessionId={sessionId} config={card.meta} onDelete={onDelete} />;
  }

  return (
    <>
      <div
        className="flex-shrink-0 rounded-xl border bg-gray-50/70 dark:bg-gray-900/70 flex flex-col overflow-hidden"
        style={{ width: "440px", height: "300px", borderColor: `${accentColor}30` }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-3 py-2 border-b flex-shrink-0"
          style={{ borderColor: `${accentColor}20` }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: accentColor }} />
            <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{label}</span>
            {stats && (
              <span className="text-sm font-mono tabular-nums ml-1" style={{ color: accentColor }}>
                {fmtVal(stats.last)} <span className="text-[10px] text-gray-500">{unit}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={handleRefresh}
              title="Refresh"
              className="p-1 rounded text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 transition-colors"
            >
              <RotateCcw size={13} className={spinning ? "animate-spin" : ""} />
            </button>
            <button
              onClick={handleDownload}
              title="Download as .npy"
              className="p-1 rounded text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 transition-colors"
            >
              <Download size={13} />
            </button>
            <button
              onClick={() => setExpanded(true)}
              title="Expand"
              className="p-1 rounded text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 transition-colors"
            >
              <Search size={13} />
            </button>
            <button
              onClick={() => setConfirmDelete(true)}
              title="Remove"
              className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 transition-colors"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        {/* Chart */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <EnergyCardContent sessionId={sessionId} type={card.type as EnergyCardType} compact refreshKey={refreshKey} maxPoints={2000} onStats={setStats} />
        </div>

        {/* Stats strip */}
        {stats && (
          <div
            className="flex justify-between px-3 py-1.5 border-t flex-shrink-0"
            style={{ borderColor: `${accentColor}15` }}
          >
            <span className="text-[10px] text-gray-400 dark:text-gray-600">
              <span className="text-gray-500">min </span>
              <span className="font-mono text-gray-600 dark:text-gray-400">{fmtVal(stats.min)}</span>
            </span>
            <span className="text-[10px] text-gray-400 dark:text-gray-600">
              <span className="text-gray-500">avg </span>
              <span className="font-mono text-gray-600 dark:text-gray-400">{fmtVal(stats.mean)}</span>
            </span>
            <span className="text-[10px] text-gray-400 dark:text-gray-600">
              <span className="text-gray-500">max </span>
              <span className="font-mono text-gray-600 dark:text-gray-400">{fmtVal(stats.max)}</span>
            </span>
          </div>
        )}
      </div>

      {/* Expanded modal */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setExpanded(false)}
        >
          <div
            className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-gray-200 dark:border-gray-700"
            style={{ width: "min(1080px, 95vw)", height: "420px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-800/80 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: accentColor }} />
                <span className="text-sm font-semibold tracking-wide" style={{ color: accentColor }}>{label}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={handleDownload} title="Download" className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
                  <Download size={12} />
                </button>
                <button onClick={handleRefresh} title="Refresh" className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
                  <RotateCcw size={12} className={spinning ? "animate-spin" : ""} />
                </button>
                <button onClick={() => setExpanded(false)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
                  <X size={14} />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <EnergyCardContent sessionId={sessionId} type={card.type as EnergyCardType} compact={false} refreshKey={refreshKey} maxPoints={50000} />
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setConfirmDelete(false)}
        >
          <div
            className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-2xl p-5 w-72"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">Remove plot?</p>
            <p className="text-xs text-gray-500 dark:text-gray-500 mb-4">The <span className="text-gray-700 dark:text-gray-300">{label}</span> plot will be removed from the results panel.</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 rounded-lg text-xs border border-gray-300 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { setConfirmDelete(false); onDelete(); }}
                className="px-3 py-1.5 rounded-lg text-xs border border-red-300/60 dark:border-red-800/60 bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Ramachandran expanded modal ───────────────────────────────────────

function RamachandranExpandedModal({
  accentColor,
  imgSrc,
  status,
  error,
  spinning,
  plotSettings,
  onClose,
  onRefresh,
  onDownload,
  onUpdateSetting,
}: {
  accentColor: string;
  imgSrc: string | null;
  status: "loading" | "ok" | "error";
  error: string | null;
  spinning: boolean;
  plotSettings: Required<RamachandranPlotSettings>;
  onClose: () => void;
  onRefresh: () => void;
  onDownload: () => void;
  onUpdateSetting: <K extends keyof RamachandranPlotSettings>(key: K, value: Required<RamachandranPlotSettings>[K]) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [settingsOpen]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-gray-200 dark:border-gray-700"
        style={{ width: "min(600px, 95vw)", height: "min(600px, 90vh)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-800/80 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: accentColor }} />
            <span className="text-sm font-semibold tracking-wide" style={{ color: accentColor }}>Ramachandran</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onRefresh}
              title="Refresh"
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <RotateCcw size={13} className={spinning ? "animate-spin" : ""} />
            </button>
            <button
              onClick={onDownload}
              disabled={status !== "ok"}
              title="Download PNG"
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download size={13} />
            </button>
            {/* Settings gear */}
            <div className="relative" ref={settingsRef}>
              <button
                onClick={() => setSettingsOpen((v) => !v)}
                title="Plot settings"
                className={`p-1.5 rounded-lg transition-colors ${
                  settingsOpen
                    ? "text-cyan-500 bg-cyan-100/50 dark:bg-cyan-900/30"
                    : "text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700"
                }`}
              >
                <Settings size={13} />
              </button>
              {settingsOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl text-xs overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800/80 border-b border-gray-200 dark:border-gray-700">
                    <span className="font-semibold text-gray-700 dark:text-gray-200">Plot Settings</span>
                    <button onClick={() => setSettingsOpen(false)} className="text-gray-500 hover:text-gray-200 transition-colors">
                      <X size={12} />
                    </button>
                  </div>
                  <div className="p-3 space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="w-20 text-gray-400 flex-shrink-0">DPI</span>
                      <input type="range" min={72} max={300} step={12} value={plotSettings.dpi}
                        onChange={(e) => onUpdateSetting("dpi", Number(e.target.value))}
                        className="flex-1 accent-cyan-500 h-1" />
                      <span className="w-8 text-right text-gray-300 tabular-nums">{plotSettings.dpi}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-20 text-gray-400 flex-shrink-0">Bins</span>
                      <input type="range" min={20} max={150} step={10} value={plotSettings.bins}
                        onChange={(e) => onUpdateSetting("bins", Number(e.target.value))}
                        className="flex-1 accent-cyan-500 h-1" />
                      <span className="w-8 text-right text-gray-300 tabular-nums">{plotSettings.bins}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-20 text-gray-400 flex-shrink-0">Colormap</span>
                      <select value={plotSettings.cmap} onChange={(e) => onUpdateSetting("cmap", e.target.value)}
                        className="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 text-gray-700 dark:text-gray-200 text-xs focus:outline-none focus:border-cyan-600">
                        {RAMACHANDRAN_CMAPS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <div className="border-t border-gray-200 dark:border-gray-800" />
                    <div className="flex items-center justify-between">
                      <span className="text-gray-500 dark:text-gray-400">Log scale</span>
                      <button onClick={() => onUpdateSetting("log_scale", !plotSettings.log_scale)}
                        className={`w-8 h-4 rounded-full transition-colors relative flex-shrink-0 ${plotSettings.log_scale ? "bg-cyan-600" : "bg-gray-700"}`}>
                        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${plotSettings.log_scale ? "left-[18px]" : "left-0.5"}`} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-500 dark:text-gray-400">Show start</span>
                      <button onClick={() => onUpdateSetting("show_start", !plotSettings.show_start)}
                        className={`w-8 h-4 rounded-full transition-colors relative flex-shrink-0 ${plotSettings.show_start ? "bg-cyan-600" : "bg-gray-700"}`}>
                        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${plotSettings.show_start ? "left-[18px]" : "left-0.5"}`} />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden flex items-center justify-center p-4">
          {status === "loading" && (
            <div className="flex flex-col items-center justify-center gap-2 text-gray-500">
              <Loader2 size={20} className="animate-spin" />
              <span className="text-sm">Generating plot…</span>
            </div>
          )}
          {status === "error" && (
            <div className="flex flex-col items-center justify-center gap-2 px-3 text-center">
              <span className="text-sm text-red-400">{error}</span>
              <button onClick={onRefresh} className="text-sm text-blue-400 hover:underline">Retry</button>
            </div>
          )}
          {status === "ok" && imgSrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imgSrc}
              alt="Ramachandran plot"
              className="max-w-full max-h-full object-contain"
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Ramachandran result card ───────────────────────────────────────────

const RAMACHANDRAN_CMAPS = ["viridis", "Blues", "Plasma", "Inferno", "Magma", "Cividis", "YlGnBu", "PuBu", "BuPu", "GnBu", "coolwarm", "Spectral"] as const;

const RAMACHANDRAN_DEFAULTS: Required<RamachandranPlotSettings> = {
  dpi: 120,
  bins: 60,
  cmap: "viridis",
  log_scale: true,
  show_start: true,
};

function RamachandranResultCard({ sessionId, onDelete }: { sessionId: string; onDelete: () => void }) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const [plotSettings, setPlotSettings] = useState<Required<RamachandranPlotSettings>>({ ...RAMACHANDRAN_DEFAULTS });
  const accentColor = "#06b6d4";

  // Close settings on outside click
  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [settingsOpen]);

  const load = (force: boolean, settings?: RamachandranPlotSettings) => {
    setStatus("loading");
    setError(null);
    const opts = settings ?? plotSettings;
    const cacheBust = force ? Date.now() : 0;
    const fetchUrl = getRamachandranImageUrl(sessionId, force, cacheBust, opts);
    fetch(fetchUrl)
      .then(async (res) => {
        if (res.ok) {
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          setImgSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
          setStatus("ok");
        } else {
          const body = await res.json().catch(() => ({}));
          setError(typeof body.detail === "string" ? body.detail : "Failed to generate plot");
          setStatus("error");
        }
      })
      .catch(() => {
        setError("Network error");
        setStatus("error");
      });
  };

  useEffect(() => { load(false); }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = () => {
    setSpinning(true);
    setTimeout(() => setSpinning(false), 800);
    load(true);
  };

  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = getRamachandranImageUrl(sessionId, false, 0, plotSettings);
    a.download = "ramachandran.png";
    a.click();
  };

  const updateSetting = <K extends keyof RamachandranPlotSettings>(key: K, value: Required<RamachandranPlotSettings>[K]) => {
    const next = { ...plotSettings, [key]: value };
    setPlotSettings(next);
    load(true, next);
  };

  return (
    <>
      <div
        className="flex-shrink-0 rounded-xl border bg-gray-50/70 dark:bg-gray-900/70 flex flex-col overflow-hidden"
        style={{ width: "300px", height: "300px", borderColor: `${accentColor}30` }}
      >
        <div
          className="flex items-center justify-between px-3 py-2 border-b flex-shrink-0"
          style={{ borderColor: `${accentColor}20` }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: accentColor }} />
            <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">Ramachandran</span>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={handleRefresh} title="Refresh" className="p-1 rounded text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 transition-colors">
              <RotateCcw size={13} className={spinning ? "animate-spin" : ""} />
            </button>
            <button onClick={handleDownload} disabled={status !== "ok"} title="Download PNG" className="p-1 rounded text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              <Download size={13} />
            </button>
            <button onClick={() => setExpanded(true)} title="Expand" className="p-1 rounded text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 transition-colors">
              <Search size={13} />
            </button>
            {/* Settings gear */}
            <div className="relative" ref={settingsRef}>
              <button
                onClick={() => setSettingsOpen((v) => !v)}
                title="Plot settings"
                className={`p-1 rounded transition-colors ${
                  settingsOpen
                    ? "text-cyan-400 bg-cyan-900/30"
                    : "text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200/60 dark:hover:bg-gray-700/60"
                }`}
              >
                <Settings size={13} />
              </button>

              {settingsOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl text-xs overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800/80 border-b border-gray-200 dark:border-gray-700">
                    <span className="font-semibold text-gray-700 dark:text-gray-200">Plot Settings</span>
                    <button onClick={() => setSettingsOpen(false)} className="text-gray-500 hover:text-gray-200 transition-colors">
                      <X size={12} />
                    </button>
                  </div>
                  <div className="p-3 space-y-3">
                    {/* DPI */}
                    <div className="flex items-center gap-2">
                      <span className="w-20 text-gray-400 flex-shrink-0">DPI</span>
                      <input
                        type="range" min={72} max={300} step={12}
                        value={plotSettings.dpi}
                        onChange={(e) => updateSetting("dpi", Number(e.target.value))}
                        className="flex-1 accent-cyan-500 h-1"
                      />
                      <span className="w-8 text-right text-gray-300 tabular-nums">{plotSettings.dpi}</span>
                    </div>
                    {/* Bins */}
                    <div className="flex items-center gap-2">
                      <span className="w-20 text-gray-400 flex-shrink-0">Bins</span>
                      <input
                        type="range" min={20} max={150} step={10}
                        value={plotSettings.bins}
                        onChange={(e) => updateSetting("bins", Number(e.target.value))}
                        className="flex-1 accent-cyan-500 h-1"
                      />
                      <span className="w-8 text-right text-gray-300 tabular-nums">{plotSettings.bins}</span>
                    </div>
                    {/* Colormap */}
                    <div className="flex items-center gap-2">
                      <span className="w-20 text-gray-400 flex-shrink-0">Colormap</span>
                      <select
                        value={plotSettings.cmap}
                        onChange={(e) => updateSetting("cmap", e.target.value)}
                        className="flex-1 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-gray-200 text-xs focus:outline-none focus:border-cyan-600"
                      >
                        {RAMACHANDRAN_CMAPS.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>
                    <div className="border-t border-gray-800" />
                    {/* Log scale toggle */}
                    <div className="flex items-center justify-between">
                      <span className="text-gray-400">Log scale</span>
                      <button
                        onClick={() => updateSetting("log_scale", !plotSettings.log_scale)}
                        className={`w-8 h-4 rounded-full transition-colors relative flex-shrink-0 ${plotSettings.log_scale ? "bg-cyan-600" : "bg-gray-700"}`}
                      >
                        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${plotSettings.log_scale ? "left-[18px]" : "left-0.5"}`} />
                      </button>
                    </div>
                    {/* Show start toggle */}
                    <div className="flex items-center justify-between">
                      <span className="text-gray-500 dark:text-gray-400">Show start</span>
                      <button
                        onClick={() => updateSetting("show_start", !plotSettings.show_start)}
                        className={`w-8 h-4 rounded-full transition-colors relative flex-shrink-0 ${plotSettings.show_start ? "bg-cyan-600" : "bg-gray-700"}`}
                      >
                        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${plotSettings.show_start ? "left-[18px]" : "left-0.5"}`} />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <button onClick={() => setConfirmDelete(true)} title="Remove" className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 transition-colors">
              <Trash2 size={13} />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden relative">
          {status === "loading" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-500">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-xs">Generating plot…</span>
            </div>
          )}
          {status === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center">
              <span className="text-xs text-red-400">{error}</span>
              <button onClick={handleRefresh} className="text-xs text-blue-400 hover:underline">Retry</button>
            </div>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imgSrc ?? ""}
            alt="Ramachandran plot"
            className="w-full h-full object-contain p-1"
            style={{ display: status === "ok" ? "block" : "none" }}
          />
        </div>
      </div>

      {/* Expanded modal */}
      {expanded && (
        <RamachandranExpandedModal
          accentColor={accentColor}
          imgSrc={imgSrc}
          status={status}
          error={error}
          spinning={spinning}
          plotSettings={plotSettings}
          onClose={() => setExpanded(false)}
          onRefresh={handleRefresh}
          onDownload={handleDownload}
          onUpdateSetting={updateSetting}
        />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setConfirmDelete(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-2xl p-5 w-72" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">Remove plot?</p>
            <p className="text-xs text-gray-500 dark:text-gray-500 mb-4">The <span className="text-gray-700 dark:text-gray-300">Ramachandran</span> plot will be removed from the results panel.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDelete(false)} className="px-3 py-1.5 rounded-lg text-xs border border-gray-300 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">Cancel</button>
              <button onClick={() => { setConfirmDelete(false); onDelete(); }} className="px-3 py-1.5 rounded-lg text-xs border border-red-300/60 dark:border-red-800/60 bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors">Remove</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function AddPlotModal({
  onSelect,
  onClose,
  onCustomCV,
  existingTypes,
  systemName,
  sessionId,
}: {
  onSelect: (types: ResultCardType[]) => void;
  onClose: () => void;
  onCustomCV: () => void;
  existingTypes: Set<ResultCardType>;
  systemName: string;
  sessionId: string;
}) {
  const [checked, setChecked] = useState<Set<ResultCardType>>(new Set());

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const availableTypes = ENERGY_CARD_TYPES.filter((t) => !existingTypes.has(t));
  const allSelected = availableTypes.length > 0 && availableTypes.every((t) => checked.has(t));
  const isAla = systemName === "ala_dipeptide";
  const ramachandranAvailable = isAla && !existingTypes.has("ramachandran");
  const ramachandranAdded = existingTypes.has("ramachandran");
  const someSelected = availableTypes.some((t) => checked.has(t));

  const toggle = (t: ResultCardType) => {
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setChecked(new Set());
    } else {
      setChecked(new Set(availableTypes));
    }
  };

  const handleRun = () => {
    const newTypes = Array.from(checked).filter((t) => !existingTypes.has(t));
    if (newTypes.length > 0) onSelect(newTypes);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-2xl p-5 w-80"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-4">Add Analysis</h3>

        {/* Energy group */}
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider leading-none">Energy</p>
          <label className={`flex items-center gap-1.5 cursor-pointer ${availableTypes.length === 0 ? "opacity-30 cursor-not-allowed" : "hover:text-gray-200"}`}>
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
              disabled={availableTypes.length === 0}
              onChange={toggleAll}
              className="accent-blue-500 w-3.5 h-3.5"
            />
            <span className="text-[10px] text-gray-500">All</span>
          </label>
        </div>
        <div className="space-y-1 mb-4">
          {ENERGY_CARD_TYPES.map((t) => {
            const alreadyAdded = existingTypes.has(t);
            const isChecked = checked.has(t) || alreadyAdded;
            return (
              <label
                key={t}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                  alreadyAdded ? "opacity-40 cursor-not-allowed" : "hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  disabled={alreadyAdded}
                  onChange={() => !alreadyAdded && toggle(t)}
                  className="accent-blue-500 w-3.5 h-3.5 flex-shrink-0"
                />
                <span className="text-xs text-gray-700 dark:text-gray-300">{ENERGY_TERM_CONFIG[t].label}</span>
                <span className="ml-auto text-[10px] text-gray-400 dark:text-gray-600">{ENERGY_TERM_CONFIG[t].unit}</span>
                {alreadyAdded && <CheckCircle2 size={11} className="text-emerald-600 flex-shrink-0" />}
              </label>
            );
          })}
        </div>

        {/* Structural group */}
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Structural</p>
        <div className="space-y-1 mb-5">
          {ramachandranAvailable ? (
            <label className="flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
              <input
                type="checkbox"
                checked={checked.has("ramachandran")}
                onChange={() => toggle("ramachandran")}
                className="accent-blue-500 w-3.5 h-3.5 flex-shrink-0"
              />
              <span className="text-xs text-gray-700 dark:text-gray-300">Ramachandran</span>
              <span className="ml-auto text-[10px] text-gray-400 dark:text-gray-600">φ/ψ map</span>
            </label>
          ) : ramachandranAdded ? (
            <div className="flex items-center gap-3 px-3 py-2 rounded-lg opacity-40">
              <input type="checkbox" checked readOnly disabled className="accent-blue-500 w-3.5 h-3.5 flex-shrink-0" />
              <span className="text-xs text-gray-700 dark:text-gray-300">Ramachandran</span>
              <span className="ml-auto text-[10px] text-gray-400 dark:text-gray-600">φ/ψ map</span>
              <CheckCircle2 size={11} className="text-emerald-600 flex-shrink-0" />
            </div>
          ) : (
            <div className="flex items-center gap-3 px-3 py-2 rounded-lg opacity-40">
              <Lock size={11} className="text-gray-600 flex-shrink-0" />
              <span className="text-xs text-gray-500 dark:text-gray-400">Ramachandran</span>
              <span className="ml-auto text-[10px] text-gray-400 dark:text-gray-500">ala dipeptide only</span>
            </div>
          )}
          <button
            onClick={() => { onClose(); onCustomCV(); }}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-left"
          >
            <FlaskConical size={11} className="text-violet-500 flex-shrink-0" />
            <span className="text-xs text-gray-700 dark:text-gray-300">Custom CV</span>
            <span className="ml-auto text-[10px] text-gray-400 dark:text-gray-500">up to 3 CVs</span>
          </button>
        </div>

        <button
          onClick={handleRun}
          disabled={checked.size === 0}
          className="w-full py-2 rounded-xl text-xs font-semibold transition-colors bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Run Analysis
        </button>
      </div>
    </div>
  );
}

// ── Simulation run confirmation modal ─────────────────────────────────

interface SimFileRow {
  label: string;
  ext: string;
  freq: number;
  frames: number;
  sizeLabel: string;
}

/** Estimate file size given approximate bytes-per-frame and total frames. */
function _estimateSize(bytesPerFrame: number, frames: number): string {
  const total = bytesPerFrame * frames;
  if (total <= 0) return "—";
  if (total < 1024) return `${total} B`;
  if (total < 1024 ** 2) return `${(total / 1024).toFixed(1)} KB`;
  if (total < 1024 ** 3) return `${(total / 1024 ** 2).toFixed(1)} MB`;
  return `${(total / 1024 ** 3).toFixed(2)} GB`;
}

// Per-frame byte estimates calibrated per atom (from alanine dipeptide 22-atom benchmark).
// xtc/trr scale linearly with atom count; edr/log are mostly atom-independent.
const BYTES_PER_FRAME_PER_ATOM: Record<string, number> = {
  xtc: 8,     // compressed coords: ~172 B / 22 atoms ≈ 8 B/atom/frame
  trr: 30,    // full precision coords+vel+force: ~648 B / 22 atoms ≈ 30 B/atom/frame
};
const BYTES_PER_FRAME_FIXED: Record<string, number> = {
  edr: 220,   // energy file — independent of atom count
  log: 580,   // log lines — independent of atom count
};

// Rough atom counts per known system (vacuum / solvated)
const SYSTEM_ATOMS: Record<string, number> = {
  ala_dipeptide: 22,
  chignolin: 6000,   // ~175 atoms + ~5800 solvent
  protein: 5000,     // generic small protein estimate
  membrane: 40000,
};

function _bytesPerFrame(ext: string, systemName: string): number {
  const nAtoms = SYSTEM_ATOMS[systemName] ?? 1000;
  if (ext in BYTES_PER_FRAME_PER_ATOM) return BYTES_PER_FRAME_PER_ATOM[ext] * nAtoms;
  return BYTES_PER_FRAME_FIXED[ext] ?? 500;
}

function SimRunConfirmModal({
  cfg,
  onEdit,
  onRun,
  onClose,
}: {
  cfg: Record<string, unknown>;
  onEdit: () => void;
  onRun: () => void;
  onClose: () => void;
}) {
  const method  = (cfg.method  ?? {}) as Record<string, unknown>;
  const gromacs = (cfg.gromacs ?? {}) as Record<string, unknown>;
  const systemCfg = (cfg.system ?? {}) as Record<string, unknown>;
  const systemName = String(systemCfg.name ?? "");

  const nsteps = Number(method.nsteps ?? 0);
  const dt     = Number(gromacs.dt    ?? 0.002); // ps per step

  const freqXtc = Number(gromacs.nstxout_compressed ?? 10);
  const freqTrr = Math.max(Number(gromacs.nstxout ?? 5000), Number(gromacs.nstvout ?? 5000));
  const freqEdr = Number(gromacs.nstenergy ?? 1000);
  const freqLog = Number(gromacs.nstlog    ?? 1000);

  const plumedCfg = (cfg.plumed ?? {}) as Record<string, unknown>;
  const cvsCfg = (plumedCfg.collective_variables ?? {}) as Record<string, unknown>;
  const methodName = String(method._target_name ?? "md");
  const needsPlumed = ["metad", "metadynamics", "opes", "umbrella", "umbrella_sampling", "steered", "steered_md"].includes(methodName);
  const colvarStride = Number(cvsCfg.colvar_stride ?? 100);
  const hillsPace = Number((method.hills as Record<string, unknown> | undefined)?.pace ?? Number(method.pace ?? 500));
  const nCvs = Array.isArray(cvsCfg.cvs) ? cvsCfg.cvs.length : 0;

  const baseRows: SimFileRow[] = [
    { label: "XTC (compressed coords)", ext: "xtc", freq: freqXtc, frames: freqXtc > 0 ? Math.floor(nsteps / freqXtc) : 0, sizeLabel: "" },
    { label: "TRR (full precision)",    ext: "trr", freq: freqTrr, frames: freqTrr > 0 ? Math.floor(nsteps / freqTrr) : 0, sizeLabel: "" },
    { label: "EDR (energies)",          ext: "edr", freq: freqEdr, frames: freqEdr > 0 ? Math.floor(nsteps / freqEdr) : 0, sizeLabel: "" },
    { label: "LOG (md.log)",            ext: "log", freq: freqLog, frames: freqLog > 0 ? Math.floor(nsteps / freqLog) : 0, sizeLabel: "" },
  ];
  if (needsPlumed && nCvs > 0) {
    // COLVAR: ~20 bytes per CV per line (time + CV values + bias)
    const colvarFrames = colvarStride > 0 ? Math.floor(nsteps / colvarStride) : 0;
    const colvarBytesPerFrame = 20 * (nCvs + 2); // time + CVs + bias
    baseRows.push({ label: "COLVAR", ext: "colvar", freq: colvarStride, frames: colvarFrames, sizeLabel: _estimateSize(colvarBytesPerFrame, colvarFrames) });
    if (["metad", "metadynamics"].includes(methodName)) {
      const hillsFrames = hillsPace > 0 ? Math.floor(nsteps / hillsPace) : 0;
      const hillsBytesPerFrame = 20 * (nCvs + 3); // time + CVs + sigma + height
      baseRows.push({ label: "HILLS", ext: "hills", freq: hillsPace, frames: hillsFrames, sizeLabel: _estimateSize(hillsBytesPerFrame, hillsFrames) });
    }
    if (methodName === "opes") {
      const kernelFrames = hillsPace > 0 ? Math.floor(nsteps / hillsPace) : 0;
      baseRows.push({ label: "KERNELS", ext: "kernels", freq: hillsPace, frames: kernelFrames, sizeLabel: _estimateSize(40 * (nCvs + 2), kernelFrames) });
    }
  }
  const rows: SimFileRow[] = baseRows.map((r) => ({
    ...r,
    sizeLabel: r.sizeLabel || _estimateSize(_bytesPerFrame(r.ext, systemName), r.frames),
  }));

  const totalPs  = nsteps * dt;
  const totalNs  = totalPs / 1000;
  const simLabel = nsteps > 0
    ? totalNs >= 1 ? `${totalNs.toFixed(2)} ns` : `${totalPs.toFixed(1)} ps`
    : "—";

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Start Simulation</h3>
            <p className="text-xs text-gray-500 mt-0.5">Total: {simLabel} · {nsteps.toLocaleString()} steps</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Logging table */}
        <div className="px-5 py-4">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-3 uppercase tracking-wider">Output logging</p>
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400">
                  <th className="text-left px-3 py-2 font-medium">File</th>
                  <th className="text-right px-3 py-2 font-medium">Every</th>
                  <th className="text-right px-3 py-2 font-medium">Frames</th>
                  <th className="text-right px-3 py-2 font-medium">Est. size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800/60">
                {rows.map((row) => (
                  <tr key={row.ext} className="text-gray-700 dark:text-gray-300">
                    <td className="px-3 py-2">
                      <span className="font-mono text-[11px] text-blue-500 dark:text-blue-400">{["colvar","hills","kernels"].includes(row.ext) ? row.ext.toUpperCase() : `.${row.ext}`}</span>
                      <span className="ml-2 text-gray-400 dark:text-gray-500">{row.label.split("(")[1]?.replace(")", "") ?? ""}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-500 dark:text-gray-400">
                      {row.freq > 0 ? `${row.freq.toLocaleString()} steps` : <span className="text-gray-300 dark:text-gray-600">off</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {row.frames > 0 ? row.frames.toLocaleString() : <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-500 dark:text-gray-400">{row.sizeLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-gray-400 dark:text-gray-600 leading-relaxed">
            Size estimates are approximate and may vary with solvent and settings.
          </p>
        </div>

        {/* Footer buttons */}
        <div className="flex gap-3 justify-end px-5 pb-5">
          <button
            onClick={onEdit}
            className="px-4 py-2 text-xs text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors font-medium"
          >
            Edit Settings
          </button>
          <button
            onClick={onRun}
            className="px-5 py-2 text-xs bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition-all shadow-lg shadow-blue-600/20 dark:shadow-blue-900/30 flex items-center gap-1.5"
          >
            <Play size={12} fill="currentColor" />
            Run
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Files tab ──────────────────────────────────────────────────────────

function FilesTab({ sessionId }: { sessionId: string }) {
  const [simFiles, setSimFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [archiveFiles, setArchiveFiles] = useState<string[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [restoringPath, setRestoringPath] = useState<string | null>(null);

  const refreshFiles = useCallback(() => {
    setSimFiles([]);
    setFilesLoading(true);
    listFiles(sessionId)
      .then(({ files }) => { setSimFiles(files.filter((f) => !isMolFile(f))); })
      .catch(() => {})
      .finally(() => setFilesLoading(false));
  }, [sessionId]);

  const refreshArchive = useCallback(() => {
    setArchiveLoading(true);
    listArchiveFiles(sessionId)
      .then(({ files }) => setArchiveFiles(files))
      .catch(() => {})
      .finally(() => setArchiveLoading(false));
  }, [sessionId]);

  useEffect(() => { refreshFiles(); }, [refreshFiles]);
  useEffect(() => { if (showArchive) refreshArchive(); }, [showArchive, refreshArchive]);

  const handleDelete = async (path: string) => {
    setDeleteTarget(null);
    setDeletingPath(path);
    try { await deleteFile(sessionId, path); } catch { /* ignore */ }
    setDeletingPath(null);
    refreshFiles();
    if (showArchive) refreshArchive();
  };

  const handleRestore = async (path: string) => {
    setRestoringPath(path);
    try { await restoreFile(sessionId, path); } catch { /* ignore */ }
    setRestoringPath(null);
    refreshFiles();
    refreshArchive();
  };

  return (
    <div className="p-4 space-y-4">
      <Section
        icon={<FileText size={13} />}
        title={`Files${simFiles.length > 0 ? ` (${simFiles.length})` : ""}`}
        accent="emerald"
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowArchive((v) => !v)}
              className={`p-1 transition-colors ${showArchive ? "text-amber-400 hover:text-amber-300" : "text-gray-500 hover:text-gray-300"}`}
              title="Show archived files"
            >
              <Archive size={15} />
            </button>
            <button
              onClick={refreshFiles}
              className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
              title="Refresh"
            >
              <RefreshCw size={15} className={filesLoading ? "animate-spin" : ""} />
            </button>
            <a
              href={downloadZipUrl(sessionId)}
              download
              className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
              title="Download all as ZIP"
            >
              <Download size={15} />
            </a>
          </div>
        }
      >
        {simFiles.length === 0 ? (
          <p className="text-xs text-gray-400 dark:text-gray-600 py-1">No simulation files yet.</p>
        ) : (
          <div className="space-y-0.5 max-h-[60vh] overflow-y-auto">
            {simFiles.map((f) => {
              const name = f.split("/").pop() ?? f;
              const isDeleting = deletingPath === f;
              return (
                <div
                  key={f}
                  className="flex items-center gap-1 px-2 py-1.5 rounded hover:bg-gray-100/60 dark:hover:bg-gray-800/60 group"
                >
                  <button
                    onClick={() => setPreviewPath(f)}
                    className="flex-1 text-left text-[13px] font-mono text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 truncate transition-colors"
                    title={name}
                  >
                    {name}
                  </button>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <button
                      onClick={() => setPreviewPath(f)}
                      title="Preview"
                      className="p-1 rounded text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                    >
                      <Eye size={12} />
                    </button>
                    <a
                      href={downloadUrl(sessionId, f)}
                      download={name}
                      title="Download"
                      className="p-1 rounded text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                    >
                      <Download size={12} />
                    </a>
                    <button
                      onClick={() => setDeleteTarget(f)}
                      disabled={isDeleting}
                      title="Move to archive"
                      className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                    >
                      {isDeleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Archive panel */}
        {showArchive && (
          <div className="mt-2 pt-3 border-t border-gray-300/40 dark:border-gray-700/40">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <Archive size={11} className="text-amber-500" />
                <span className="text-[10px] font-semibold text-amber-500/80 uppercase tracking-wider">
                  Archive{archiveFiles.length > 0 ? ` (${archiveFiles.length})` : ""}
                </span>
              </div>
              <button
                onClick={refreshArchive}
                className="p-0.5 text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400 transition-colors"
                title="Refresh archive"
              >
                <RefreshCw size={11} className={archiveLoading ? "animate-spin" : ""} />
              </button>
            </div>
            {archiveLoading ? (
              <div className="flex justify-center py-2">
                <Loader2 size={14} className="animate-spin text-gray-600" />
              </div>
            ) : archiveFiles.length === 0 ? (
              <p className="text-xs text-gray-400 dark:text-gray-600 py-1">Archive is empty.</p>
            ) : (
              <div className="space-y-0.5 max-h-40 overflow-y-auto">
                {archiveFiles.map((f) => {
                  const name = f.split("/").pop() ?? f;
                  const isRestoring = restoringPath === f;
                  return (
                    <div
                      key={f}
                      className="flex items-center gap-1 px-2 py-1.5 rounded hover:bg-gray-100/60 dark:hover:bg-gray-800/60 group"
                    >
                      <span
                        className="flex-1 text-[13px] font-mono text-gray-500 dark:text-gray-500 truncate"
                        title={name}
                      >
                        {name}
                      </span>
                      <button
                        onClick={() => handleRestore(f)}
                        disabled={isRestoring}
                        title="Restore to working directory"
                        className="p-1 rounded text-gray-400 dark:text-gray-600 hover:text-emerald-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 opacity-0 group-hover:opacity-100"
                      >
                        {isRestoring ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </Section>

      {previewPath && (
        <FilePreviewModal sessionId={sessionId} path={previewPath} onClose={() => setPreviewPath(null)} />
      )}
      {deleteTarget && (
        <DeleteConfirmPopup
          name={deleteTarget.split("/").pop() ?? deleteTarget}
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

// ── Progress tab ───────────────────────────────────────────────────────

function ProgressTab({
  sessionId,
  runStatus,
  exitCode,
  totalSteps,
  timestepPs,
  runStartedAt,
  runFinishedAt,
  resultCards,
  setResultCards,
  systemName,
}: {
  sessionId: string;
  runStatus: "standby" | "running" | "finished" | "failed" | "paused";
  exitCode: number | null;
  totalSteps: number;
  timestepPs: number;
  runStartedAt: number | null;
  runFinishedAt?: number | null;
  resultCards: ResultCardDef[];
  setResultCards: React.Dispatch<React.SetStateAction<ResultCardDef[]>>;
  systemName: string;
}) {
  const [agentOpen, setAgentOpen] = useState(false);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [filesLoadedFor, setFilesLoadedFor] = useState("");
  const [filesLoading, setFilesLoading] = useState(false);
  const [trajectoryKey, setTrajectoryKey] = useState(0);
  const [addPlotOpen, setAddPlotOpen] = useState(false);
  const [cvSetupOpen, setCvSetupOpen] = useState(false);
  const [liveProgress, setLiveProgress] = useState<{ step: number; time_ps: number; ns_per_day: number } | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const normalizeProgress = (p: { step?: unknown; time_ps?: unknown; ns_per_day?: unknown } | null | undefined) => {
    if (!p) return null;
    const step = Number(p.step);
    const timePs = Number(p.time_ps);
    const nsPerDay = Number(p.ns_per_day);
    return {
      step: Number.isFinite(step) ? step : 0,
      time_ps: Number.isFinite(timePs) ? timePs : 0,
      ns_per_day: Number.isFinite(nsPerDay) ? nsPerDay : 0,
    };
  };

  const refreshFiles = useCallback(() => {
    setAllFiles([]);
    setFilesLoadedFor("");
    setFilesLoading(true);
    listFiles(sessionId)
      .then(({ files }) => {
        setAllFiles(files);
        setFilesLoadedFor(sessionId);
      })
      .catch(() => {})
      .finally(() => setFilesLoading(false));
  }, [sessionId]);

  useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  // Refresh file list when the simulation finishes so trajectory/output files appear immediately
  const prevRunStatus = useRef(runStatus);
  useEffect(() => {
    if (prevRunStatus.current !== runStatus && (runStatus === "finished" || runStatus === "failed")) {
      refreshFiles();
    }
    prevRunStatus.current = runStatus;
  }, [runStatus, refreshFiles]);

  useEffect(() => {
    let cancelled = false;
    const isActiveRun = runStatus === "running";
    const tickNow = () => setNowMs(Date.now());
    const intervalNow = isActiveRun ? setInterval(tickNow, 1000) : null;

    const pollProgress = async () => {
      try {
        const primary = await getProgress(sessionId, "simulation/md.log");
        if (cancelled) return;
        if (primary.available && primary.progress) {
          setLiveProgress(normalizeProgress(primary.progress));
          return;
        }
        const fallback = await getProgress(sessionId, "md.log");
        if (cancelled) return;
        setLiveProgress(fallback.available ? normalizeProgress(fallback.progress) : null);
      } catch {
        if (!cancelled) setLiveProgress(null);
      }
    };

    void pollProgress();
    const intervalProgress = isActiveRun ? setInterval(() => { void pollProgress(); }, 2000) : null;
    return () => {
      cancelled = true;
      if (intervalNow) clearInterval(intervalNow);
      if (intervalProgress) clearInterval(intervalProgress);
    };
  }, [sessionId, runStatus]);

  // Only use file lists that were fetched for the current session to avoid
  // a stale-render window where allFiles still belongs to a previous session.
  const _freshFiles = filesLoadedFor === sessionId ? allFiles : [];
  const _allNames = _freshFiles.map((f) => ({
    path: f,
    normalizedPath: f.replace(/\\/g, "/").toLowerCase(),
    name: fileBaseName(f),
    lower: fileBaseName(f).toLowerCase(),
  }));
  const trajectoryFile = _allNames.find((f) => f.normalizedPath.includes("/simulation/") && f.lower.endsWith(".xtc"))
    ?? _allNames.find((f) => f.lower.endsWith(".xtc"))
    ?? _allNames.find((f) => f.normalizedPath.includes("/simulation/") && f.lower.endsWith(".trr"))
    ?? _allNames.find((f) => f.lower.endsWith(".trr"));
  const topologyFile = _allNames.find((f) => f.lower.endsWith("_ionized.gro"))
    ?? _allNames.find((f) => f.lower.endsWith("_solvated.gro"))
    ?? _allNames.find((f) => f.lower.endsWith("_box.gro"))
    ?? _allNames.find((f) => f.lower.endsWith("_system.gro"))
    ?? _allNames.find((f) => f.lower.endsWith(".gro"))
    ?? _allNames.find((f) => f.lower.endsWith(".pdb"));
  const targetSteps = Number.isFinite(totalSteps) && totalSteps > 0 ? totalSteps : 0;
  const pctRaw = targetSteps > 0 && liveProgress
    ? Math.max(0, Math.min(100, (liveProgress.step / targetSteps) * 100))
    : 0;
  const pct = runStatus === "finished" ? 100 : pctRaw;
  // Only use the live `nowMs` ticker while the sim is actively running.
  // If finished but `runFinishedAt` hasn't arrived yet, show "—" rather than
  // currentTime − pastStartTime (which would display an inflated elapsed time).
  const elapsedMs: number | null = !runStartedAt
    ? null
    : runFinishedAt
      ? Math.max(0, runFinishedAt - runStartedAt)
      : (runStatus === "running" || runStatus === "paused")
        ? Math.max(0, nowMs - runStartedAt)
        : null;
  const elapsedLabel = elapsedMs !== null ? formatElapsed(elapsedMs) : "—";
  const simNs = liveProgress ? liveProgress.time_ps / 1000 : 0;
  const totalSimPs = totalSteps * timestepPs;
  const totalSimNs = totalSimPs / 1000;
  const computedNsPerDay = elapsedMs != null && elapsedMs > 0 && simNs > 0
    ? (simNs * 86400000) / elapsedMs
    : null;
  const runStatusBadge = runStatus === "running"
    ? { label: "Running",  className: "text-green-400" }
    : runStatus === "paused"
      ? { label: "Paused", className: "text-amber-400" }
      : runStatus === "finished"
        ? { label: "Finished", className: "text-blue-400" }
        : runStatus === "failed"
          ? { label: `Failed${exitCode !== null ? ` (exit ${exitCode})` : ""}`, className: "text-red-400" }
          : { label: "Standby", className: "text-gray-400" };

  return (
    <div className="p-4 space-y-4">
      <Section
        icon={<Activity size={13} />}
        title="Run Summary"
        accent="emerald"
        action={<span className={`text-xs font-semibold ${runStatusBadge.className}`}>{runStatusBadge.label}</span>}
      >
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-gray-50/70 dark:bg-gray-900/70 border border-gray-200 dark:border-gray-800 rounded-lg p-2">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Wall Time</p>
            <p className="text-sm font-mono text-gray-800 dark:text-gray-200">{elapsedLabel}</p>
          </div>
          <div className="bg-gray-50/70 dark:bg-gray-900/70 border border-gray-200 dark:border-gray-800 rounded-lg p-2">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Sim Time</p>
            <p className="text-sm font-mono text-gray-800 dark:text-gray-200">
              {simNs.toFixed(3)}{totalSimNs > 0 ? ` / ${totalSimNs.toFixed(1)} ns` : " ns"}
            </p>
          </div>
          <div className="bg-gray-50/70 dark:bg-gray-900/70 border border-gray-200 dark:border-gray-800 rounded-lg p-2">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Performance</p>
            <p className="text-sm font-mono text-gray-800 dark:text-gray-200">
              {computedNsPerDay !== null ? `${computedNsPerDay.toFixed(2)} ns/day` : "—"}
            </p>
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-500">
            <span>
              {runStatus === "finished"
                ? `${targetSteps.toLocaleString()} / ${targetSteps.toLocaleString()} steps`
                : liveProgress
                  ? `${liveProgress.step.toLocaleString()} / ${targetSteps.toLocaleString()} steps`
                  : "Waiting for md.log..."}
            </span>
            <span>{(runStatus === "finished" || (liveProgress && targetSteps > 0)) ? `${pct.toFixed(1)}%` : "0.0%"}</span>
          </div>
          <div className="h-2.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </Section>

      <Section
        icon={<Play size={13} />}
        title="Trajectory"
        accent="blue"
        action={
          runStatus === "finished" ? (
            <button
              onClick={() => { refreshFiles(); setTrajectoryKey((k) => k + 1); }}
              className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
              title="Refresh trajectory"
            >
              <RefreshCw size={13} className={filesLoading ? "animate-spin" : ""} />
            </button>
          ) : undefined
        }
      >
        <TrajectoryViewer
          key={`${sessionId}-${trajectoryKey}`}
          sessionId={sessionId}
          topologyPath={runStatus === "finished" ? (topologyFile?.path ?? null) : null}
          trajectoryPath={runStatus === "finished" ? (trajectoryFile?.path ?? null) : null}
          isLoading={runStatus === "finished" && (filesLoading || filesLoadedFor !== sessionId)}
        />
      </Section>

      {/* Results section */}
      <Section
        icon={<Layers size={13} />}
        title={`Results${resultCards.length > 0 ? ` (${resultCards.length})` : ""}`}
        accent="indigo"
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAgentOpen(true)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200/60 dark:border-indigo-800/50 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-800/40 transition-colors"
            >
              <Bot size={11} />
              Analyze
            </button>
            <button
              onClick={() => setAddPlotOpen(true)}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-indigo-400 hover:bg-indigo-900/30 transition-colors font-medium"
            >
              <Plus size={12} />
              Add
            </button>
          </div>
        }
      >
        {/* Horizontal scrollable card row */}
        <div className="flex gap-3 overflow-x-auto pb-1 -mx-3 px-3" style={{ scrollbarWidth: "thin" }}>
          {resultCards.length === 0 ? (
            <button
              onClick={() => setAddPlotOpen(true)}
              className="w-full rounded-lg border border-dashed border-gray-300 dark:border-gray-700 bg-gray-100/30 dark:bg-gray-900/30 hover:bg-gray-200/40 dark:hover:bg-gray-800/40 hover:border-gray-400 dark:hover:border-gray-600 transition-colors flex items-center justify-center gap-2 text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400"
              style={{ height: "300px" }}
            >
              <Plus size={16} />
              <span className="text-xs">Add analysis plot</span>
            </button>
          ) : (
            <>
              {[...resultCards].reverse().map((card) => (
                <ResultCard
                  key={card.id}
                  card={card}
                  sessionId={sessionId}
                  onDelete={() => setResultCards((prev) => prev.filter((c) => c.id !== card.id))}
                />
              ))}
              {/* Add button */}
              <button
                onClick={() => setAddPlotOpen(true)}
                className="flex-shrink-0 rounded-xl border border-dashed border-gray-300 dark:border-gray-700 bg-gray-100/30 dark:bg-gray-900/30 hover:bg-gray-200/40 dark:hover:bg-gray-800/40 hover:border-gray-400 dark:hover:border-gray-600 transition-colors flex flex-col items-center justify-center gap-2 text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400"
                style={{ width: "120px", height: "300px" }}
              >
                <Plus size={18} />
                <span className="text-xs">Add</span>
              </button>
            </>
          )}
        </div>
      </Section>

      {addPlotOpen && (
        <AddPlotModal
          onSelect={(types) => {
            setResultCards((prev) => [
              ...prev,
              ...types.map((type) => ({ id: uuid(), type })),
            ]);
          }}
          onClose={() => setAddPlotOpen(false)}
          onCustomCV={() => setCvSetupOpen(true)}
          existingTypes={new Set(resultCards.map((c) => c.type))}
          systemName={systemName}
          sessionId={sessionId}
        />
      )}

      {cvSetupOpen && (
        <CVSetupModal
          sessionId={sessionId}
          onConfirm={(cvDefs) => {
            const meta: CustomCVConfig = { cvs: cvDefs.map((d) => ({ type: d.type, atoms: d.atoms, label: d.label })) };
            setResultCards((prev) => [
              ...prev,
              { id: uuid(), type: "custom_cv" as ResultCardType, meta },
            ]);
            setCvSetupOpen(false);
          }}
          onClose={() => setCvSetupOpen(false)}
        />
      )}

      {agentOpen && (
        <AgentModal sessionId={sessionId} agentType="analysis" onClose={() => setAgentOpen(false)} />
      )}
    </div>
  );
}

// ── Molecule tab ────────────────────────────────────────────────────────

function MoleculeTab({
  sessionId,
  cfg,
  selectedMolecule,
  moleculeLoading,
  onSelectMolecule,
  onMoleculeDeleted,
}: {
  sessionId: string;
  cfg: Record<string, unknown>;
  selectedMolecule: { content: string; name: string } | null;
  moleculeLoading?: boolean;
  onSelectMolecule: (m: { content: string; name: string }) => void;
  onMoleculeDeleted: (name: string) => void;
}) {
  const system = (cfg.system ?? {}) as Record<string, unknown>;
  const systemLabel = SYSTEM_LABELS[system.name as string] ?? (system.name as string) ?? "";
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [fileRefresh, setFileRefresh] = useState(0);
  const [viewLoading, setViewLoading] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [expandedRoots, setExpandedRoots] = useState<Record<string, boolean>>({});
  const [molLibrary, setMolLibrary] = useState<{ id: string; label: string; states: { name: string; file: string }[] }[]>([]);
  const [molLibLoading, setMolLibLoading] = useState<string | null>(null);

  // Fetch molecule library for suggestions
  useEffect(() => {
    getMolecules().then((r) => setMolLibrary(r.systems)).catch(() => {});
  }, []);

  const refreshFiles = useCallback(() => {
    setLoading(true);
    setFiles([]);  // clear stale list from previous session immediately
    listFiles(sessionId)
      .then(({ files, work_dir }) => {
        const base = work_dir.replace(/\\/g, "/").replace(/\/+$/, "");
        const visible = files.filter((f) => {
          const p = f.replace(/\\/g, "/");
          return !p.startsWith(`${base}/simulation/`) && !p.includes("/simulation/");
        });
        setFiles(visible);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => {
    refreshFiles();
  }, [refreshFiles, fileRefresh]);

  const handleDelete = async (filePath: string) => {
    const name = filePath.split("/").pop() ?? filePath;
    setDeleteLoading(name);
    try {
      await deleteFile(sessionId, filePath);
      onMoleculeDeleted(name);
      setFileRefresh((n) => n + 1);
    } catch {
      /* ignore */
    } finally {
      setDeleteLoading(null);
    }
  };

  const handleLoadFromLibrary = async (systemId: string, stateName: string) => {
    const key = `${systemId}/${stateName}`;
    setMolLibLoading(key);
    try {
      const { loaded } = await loadMolecule(sessionId, systemId, stateName);
      setFileRefresh((n) => n + 1);
      // Load the file content into the viewer
      const content = await getFileContent(sessionId, loaded);
      onSelectMolecule({ content, name: loaded });
    } catch { /* ignore */ }
    finally { setMolLibLoading(null); }
  };

  const handleSelect = async (filePath: string) => {
    const name = filePath.split("/").pop() ?? filePath;
    setViewLoading(name);
    try {
      const content = await getFileContent(sessionId, filePath);
      onSelectMolecule({ content, name });
    } catch {
      /* ignore */
    } finally {
      setViewLoading(null);
    }
  };

  const molFiles = files.filter(isMolFile);
  const coordHintRaw = String(system.coordinates ?? "");
  const coordHintName = fileBaseName(coordHintRaw);
  const originHint = !isDerivedMolName(coordHintName)
    ? coordHintRaw
    : (selectedMolecule?.name && !isDerivedMolName(selectedMolecule.name) ? selectedMolecule.name : "");
  const molTree = buildMolTreeGroups(molFiles, originHint);

  useEffect(() => {
    if (molTree.length === 0) return;
    setExpandedRoots((prev) => {
      const next = { ...prev };
      for (const g of molTree) {
        if (next[g.root.name] === undefined) next[g.root.name] = true;
      }
      return next;
    });
  }, [molTree]);

  return (
    <div className="p-4 space-y-4">
      {/* Inline 3D viewer */}
      {selectedMolecule ? (
        <Section
          icon={<Eye size={13} />}
          title={systemLabel ? `${systemLabel} — ${selectedMolecule.name}` : selectedMolecule.name}
          accent="indigo"
        >
          <MoleculeViewer
            fileContent={selectedMolecule.content}
            fileName={selectedMolecule.name}
            inline={true}
          />
        </Section>
      ) : (moleculeLoading || viewLoading) ? (
        <div
          className="relative rounded-xl border border-gray-300/60 dark:border-gray-700/60 bg-gray-50 dark:bg-gray-900 overflow-hidden flex items-center justify-center"
          style={{ height: "360px" }}
        >
          <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
            <Loader2 size={20} className="animate-spin" />
            <span className="text-sm">Loading molecule…</span>
          </div>
        </div>
      ) : molLibrary.length > 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300/60 dark:border-gray-700/60 bg-gray-50/40 dark:bg-gray-900/40 p-5">
          <div className="text-center mb-4">
            <FlaskConical size={24} className="mx-auto text-gray-400 dark:text-gray-600 mb-2" />
            <p className="text-xs text-gray-500">No molecule selected. Load one from the library:</p>
          </div>
          <div className="grid grid-cols-1 gap-2">
            {molLibrary.map((sys) => (
              <div key={sys.id} className="rounded-lg border border-gray-300/50 dark:border-gray-700/50 bg-gray-100/40 dark:bg-gray-800/40 p-3">
                <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">{sys.label}</p>
                <div className="flex flex-wrap gap-1.5">
                  {sys.states.map((st) => {
                    const key = `${sys.id}/${st.name}`;
                    const isLoading = molLibLoading === key;
                    return (
                      <button
                        key={st.name}
                        onClick={() => handleLoadFromLibrary(sys.id, st.name)}
                        disabled={!!molLibLoading}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs bg-indigo-900/30 border border-indigo-800/40 text-indigo-300 hover:bg-indigo-800/40 hover:text-indigo-200 transition-colors disabled:opacity-50 font-mono"
                      >
                        {isLoading ? <Loader2 size={10} className="animate-spin" /> : <FlaskConical size={10} />}
                        {st.file}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Molecule files + integrated upload */}
      <Section
        icon={<FlaskConical size={13} />}
        title="Molecule Files"
        accent="indigo"
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAgentOpen(true)}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-100/40 dark:hover:bg-blue-900/30 transition-colors font-medium"
            >
              <Bot size={12} />
              Search
            </button>
            <button
              onClick={refreshFiles}
              className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
              title="Refresh"
            >
              <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        }
      >

        {molTree.length > 0 && (
          <div className="space-y-1.5 mb-3">
            {molTree.map((group) => {
              const nodes = [group.root, ...(expandedRoots[group.root.name] ? group.children : [])];
              return (
                <div key={group.root.path} className="space-y-1">
                  {nodes.map((node, idx) => {
                    const f = node.path;
                    const name = node.name;
                    const isLoading = viewLoading === name;
                    const isDeleting = deleteLoading === name;
                    const isSelected = selectedMolecule?.name === name;
                    const isRoot = idx === 0;
                    return (
                      <div
                        key={f}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border ${
                          isSelected
                            ? "bg-indigo-50/40 dark:bg-indigo-950/40 border-indigo-300/60 dark:border-indigo-700/60"
                            : "bg-gray-100/50 dark:bg-gray-800/50 border-gray-300/50 dark:border-gray-700/50"
                        }`}
                        style={{ marginLeft: isRoot ? "0px" : "16px" }}
                      >
                        {isRoot ? (
                          <button
                            onClick={() => setExpandedRoots((s) => ({ ...s, [group.root.name]: !s[group.root.name] }))}
                            className="text-gray-500 hover:text-gray-300 transition-colors"
                            title={expandedRoots[group.root.name] ? "Collapse tree" : "Expand tree"}
                          >
                            {expandedRoots[group.root.name] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          </button>
                        ) : (
                          <span className="text-gray-500 text-xs font-mono w-3 text-center">└</span>
                        )}
                        <span className="text-base">{node.isDerived ? "🧪" : "🧬"}</span>
                        <span className="text-xs text-gray-800 dark:text-gray-200 truncate flex-1 font-mono" title={f}>
                          {name}
                        </span>
                        {node.isDerived && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded border border-gray-300/60 dark:border-gray-700/60 text-gray-500 bg-gray-100/70 dark:bg-gray-900/70">
                            intermediate
                          </span>
                        )}
                        <button
                          onClick={() => handleSelect(f)}
                          disabled={isLoading || isDeleting}
                          className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs border transition-colors disabled:opacity-50 flex-shrink-0 ${
                            isSelected
                              ? "bg-indigo-600/80 hover:bg-indigo-500 text-white border-indigo-500/50"
                              : "bg-indigo-700/70 hover:bg-indigo-600 text-indigo-200 border-indigo-700/50"
                          }`}
                        >
                          {isLoading
                            ? <RefreshCw size={10} className="animate-spin" />
                            : isSelected
                            ? <CheckCircle2 size={10} />
                            : null}
                          {isSelected ? "Selected" : "Select"}
                        </button>
                        <button
                          onClick={() => setPreviewPath(f)}
                          title="Preview file content"
                          className="flex items-center justify-center p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-indigo-500 dark:hover:text-indigo-300 hover:bg-indigo-100/20 dark:hover:bg-indigo-900/20 border border-gray-300/50 dark:border-gray-700/50 hover:border-indigo-300/40 dark:hover:border-indigo-800/40 transition-colors flex-shrink-0"
                        >
                          <Eye size={11} />
                        </button>
                        <a
                          href={downloadUrl(sessionId, f)}
                          download={name}
                          className="flex items-center justify-center p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-blue-100/20 dark:hover:bg-blue-900/20 border border-gray-300/50 dark:border-gray-700/50 hover:border-blue-300/40 dark:hover:border-blue-800/40 transition-colors flex-shrink-0"
                          title="Download file"
                        >
                          <Download size={11} />
                        </a>
                        <button
                          onClick={() => handleDelete(f)}
                          disabled={isDeleting || isLoading}
                          className="flex items-center justify-center p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-100/20 dark:hover:bg-red-900/20 border border-gray-300/50 dark:border-gray-700/50 hover:border-red-300/40 dark:hover:border-red-800/40 transition-colors disabled:opacity-50 flex-shrink-0"
                          title="Delete file"
                        >
                          {isDeleting
                            ? <RefreshCw size={11} className="animate-spin" />
                            : <Trash2 size={11} />}
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}

        {/* Upload dropzone integrated here */}
        <FileUpload sessionId={sessionId} onUploaded={() => setFileRefresh((n) => n + 1)} />
      </Section>

      {/* Molecule library recommendations */}
      {molLibrary.length > 0 && (
        <Section icon={<FlaskConical size={13} />} title="Molecule Library" accent="blue">
          <div className="space-y-2">
            {molLibrary.map((sys) => (
              <div key={sys.id} className="flex items-center gap-3">
                <span className="text-xs font-medium text-gray-600 dark:text-gray-400 w-28 truncate flex-shrink-0">{sys.label}</span>
                <div className="flex flex-wrap gap-1.5 flex-1">
                  {sys.states.map((st) => {
                    const key = `${sys.id}/${st.name}`;
                    const isLoading = molLibLoading === key;
                    return (
                      <button
                        key={st.name}
                        onClick={() => handleLoadFromLibrary(sys.id, st.name)}
                        disabled={!!molLibLoading}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-gray-100/60 dark:bg-gray-800/60 border border-gray-300/50 dark:border-gray-700/50 text-gray-700 dark:text-gray-300 hover:bg-indigo-100/30 dark:hover:bg-indigo-900/30 hover:border-indigo-300/40 dark:hover:border-indigo-700/40 hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors disabled:opacity-50 font-mono"
                      >
                        {isLoading ? <Loader2 size={9} className="animate-spin" /> : <FlaskConical size={9} />}
                        {st.file}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {agentOpen && (
        <AgentModal sessionId={sessionId} agentType="paper" onClose={() => setAgentOpen(false)} />
      )}
      {previewPath && (
        <FilePreviewModal sessionId={sessionId} path={previewPath} onClose={() => setPreviewPath(null)} />
      )}
    </div>
  );
}

// ── GROMACS tab ────────────────────────────────────────────────────────

function GpuCpuToggle({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isGpu = value !== "" && value !== "cpu";
  const [gpuLabel, setGpuLabel] = useState(isGpu ? `GPU ${value}` : "GPU (auto)");
  const [checking, setChecking] = useState(false);

  const selectGpu = () => {
    setChecking(true);
    getAvailableGpu()
      .then((r) => {
        if (r.available && r.gpu_id) {
          onChange(r.gpu_id);
          setGpuLabel(`GPU ${r.gpu_id}`);
        } else {
          setGpuLabel("No GPU free");
          // Stay on CPU if no GPU available
        }
      })
      .catch(() => { setGpuLabel("GPU (error)"); })
      .finally(() => setChecking(false));
  };

  const selectCpu = () => {
    onChange("");
    setGpuLabel("GPU (auto)");
  };

  // On mount, if GPU is selected, verify it
  useEffect(() => {
    if (isGpu) setGpuLabel(`GPU ${value}`);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <label className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-1.5 block">Compute</label>
      <div className="flex rounded-lg border border-gray-300 dark:border-gray-700 overflow-hidden h-[38px]">
        <button
          type="button"
          onClick={selectGpu}
          disabled={checking}
          className={`flex-1 flex items-center justify-center gap-1.5 text-sm font-medium transition-colors ${
            isGpu
              ? "bg-emerald-100/40 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 border-r border-gray-300 dark:border-gray-700"
              : "bg-gray-100/40 dark:bg-gray-800/40 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 border-r border-gray-300 dark:border-gray-700"
          }`}
        >
          {checking ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
          {isGpu ? gpuLabel : "GPU"}
        </button>
        <button
          type="button"
          onClick={selectCpu}
          className={`flex-1 flex items-center justify-center gap-1.5 text-sm font-medium transition-colors ${
            !isGpu
              ? "bg-blue-100/40 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400"
              : "bg-gray-100/40 dark:bg-gray-800/40 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800"
          }`}
        >
          <Cpu size={12} />
          CPU
        </button>
      </div>
    </div>
  );
}

function GromacsTab({
  sessionId,
  cfg,
  onChange,
  onSave,
  saveState,
  runStatus,
}: {
  sessionId: string;
  cfg: Record<string, unknown>;
  onChange: (k: string, v: unknown) => void;
  onSave: () => void;
  saveState: "idle" | "saving" | "saved";
  runStatus: "standby" | "running" | "finished" | "failed" | "paused";
}) {
  const gromacs = (cfg.gromacs ?? {}) as Record<string, unknown>;
  const method  = (cfg.method  ?? {}) as Record<string, unknown>;
  const system  = (cfg.system  ?? {}) as Record<string, unknown>;
  const isLocked = runStatus === "running" || runStatus === "finished";
  const [agentOpen, setAgentOpen] = useState(false);

  return (
    <div className="p-4 space-y-4">
      {/* Sticky header with agent button */}
      <div className="sticky top-0 z-20 -mx-4 px-4 py-1.5 bg-gray-50/95 dark:bg-gray-950/95 backdrop-blur border-b border-gray-200/80 dark:border-gray-800/80">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">GROMACS Parameters</h3>
          <div className="flex items-center gap-2">
            {!isLocked && (
              <button
                onClick={() => setAgentOpen(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200/60 dark:border-indigo-800/50 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-800/40 transition-colors"
              >
                <Bot size={11} />
                Suggest Settings
              </button>
            )}
            {isLocked && (
              <span className="inline-flex items-center gap-1 text-xs text-amber-500 dark:text-amber-400">
                <Lock size={12} />
                Locked
              </span>
            )}
          </div>
        </div>
      </div>

      <fieldset disabled={isLocked} className={isLocked ? "space-y-4 opacity-70" : "space-y-4"}>
        {/* System */}
        <Section icon={<FlaskConical size={13} />} title="System" accent="emerald">
          <FieldGrid>
            <SelectField
              label="Force Field"
              value={String(system.forcefield ?? "amber99sb-ildn")}
              onChange={(v) => onChange("system.forcefield", v)}
              onSave={onSave}
              options={[
                { value: "amber99sb-ildn", label: "AMBER99SB-ILDN" },
                { value: "charmm27",       label: "CHARMM27"       },
                { value: "charmm36m",      label: "CHARMM36m"      },
              ]}
            />
            <SelectField
              label="Solvent"
              value={String(system.water_model ?? "tip3p")}
              onChange={(v) => onChange("system.water_model", v)}
              onSave={onSave}
              options={[
                { value: "none",  label: "Vacuum"      },
                { value: "tip3p", label: "TIP3P Water" },
              ]}
            />
            <Field
              label="Box clearance"
              type="number"
              value={String(gromacs.box_clearance ?? "1.5")}
              onChange={(v) => onChange("gromacs.box_clearance", Number(v))}
              onBlur={onSave}
              unit="nm"
            />
            <GpuCpuToggle
              value={String(gromacs.gpu_id ?? "")}
              onChange={(v) => { onChange("gromacs.gpu_id", v); onSave(); }}
            />
          </FieldGrid>
          <p className="text-xs text-gray-500 dark:text-gray-600">
            Minimum distance from the molecule to the box edge (editconf <code className="font-mono">-d</code>).
            Must satisfy: clearance × √3/2 &gt; max cutoff ({String((gromacs.rcoulomb as number | undefined) ?? 1.0)} nm).
          </p>
        </Section>

        {/* Simulation length */}
        {(() => {
          const nsteps = Number(method.nsteps ?? 0);
          const dt = Number(gromacs.dt ?? 0.002);
          const totalPs = nsteps * dt;
          const totalLabel = nsteps > 0
            ? totalPs < 1
              ? `${(totalPs * 1000).toFixed(0)} fs`
              : totalPs < 1000
                ? `${totalPs % 1 === 0 ? totalPs.toFixed(0) : totalPs.toFixed(2)} ps`
                : `${(totalPs / 1000).toFixed(3).replace(/\.?0+$/, "")} ns`
            : null;
          return (
            <Section
              icon={<Binary size={13} />}
              title="Simulation Length"
              accent="blue"
              action={totalLabel && (
                <span className="text-xs font-mono text-blue-400">{totalLabel}</span>
              )}
            >
              <FieldGrid>
                <Field
                  label="Steps"
                  type="number"
                  value={String(method.nsteps ?? "")}
                  onChange={(v) => onChange("method.nsteps", Number(v))}
                  onBlur={onSave}
                  hint="Total MD steps to run."
                />
                <Field
                  label="Timestep"
                  type="number"
                  value={String(Number(gromacs.dt ?? 0.002) * 1000)}
                  onChange={(v) => onChange("gromacs.dt", Number(v) / 1000)}
                  onBlur={onSave}
                  unit="fs"
                  hint="2 fs is standard."
                />
              </FieldGrid>
            </Section>
          );
        })()}

        {/* Thermostat */}
        <Section icon={<Thermometer size={13} />} title="Temperature" accent="amber">
          <FieldGrid>
            <Field
              label="Reference Temperature"
              type="number"
              value={String(Array.isArray(gromacs.ref_t) ? (gromacs.ref_t as number[])[0] : gromacs.ref_t ?? gromacs.temperature ?? "300")}
              onChange={(v) => onChange("gromacs.ref_t", [Number(v)])}
              onBlur={onSave}
              unit="K"
              hint="Target temperature (V-rescale)."
            />
            <Field
              label="Thermostat time constant"
              type="number"
              value={String(Array.isArray(gromacs.tau_t) ? (gromacs.tau_t as number[])[0] : gromacs.tau_t ?? "0.1")}
              onChange={(v) => onChange("gromacs.tau_t", [Number(v)])}
              onBlur={onSave}
              unit="ps"
              hint="τ for V-rescale coupling."
            />
          </FieldGrid>
        </Section>

      </fieldset>

      {/* Advanced — outside fieldset so toggle works when locked */}
      <AdvancedSection cfg={cfg} onChange={onChange} onSave={onSave} isLocked={isLocked} />

      {agentOpen && (
        <AgentModal sessionId={sessionId} agentType="paper" onClose={() => setAgentOpen(false)} />
      )}
    </div>
  );
}

function AdvancedSection({
  cfg,
  onChange,
  onSave,
  isLocked,
}: {
  cfg: Record<string, unknown>;
  onChange: (k: string, v: unknown) => void;
  onSave: () => void;
  isLocked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const gromacs = (cfg.gromacs ?? {}) as Record<string, unknown>;

  return (
    <div className="rounded-xl border border-gray-300/40 dark:border-gray-700/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-50/60 dark:bg-gray-900/60 hover:bg-gray-100/60 dark:hover:bg-gray-800/60 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown size={12} className="text-gray-500" /> : <ChevronRight size={12} className="text-gray-500" />}
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Advanced Parameters</span>
        </div>
        <span className="text-[10px] text-gray-400 dark:text-gray-600">Cutoffs, electrostatics, constraints, output…</span>
      </button>

      {open && (
        <fieldset disabled={isLocked} className={isLocked ? "space-y-3 opacity-70" : "space-y-3"}>
        <div className="p-3 space-y-5 border-t border-gray-300/40 dark:border-gray-700/40 bg-gray-50/20 dark:bg-gray-900/20">
          {/* Non-bonded cutoffs */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Non-bonded Cutoffs</p>
            <FieldGrid>
              <Field
                label="Coulomb cutoff"
                type="number"
                value={String(gromacs.rcoulomb ?? "1.0")}
                onChange={(v) => onChange("gromacs.rcoulomb", Number(v))}
                onBlur={onSave}
                unit="nm"
              />
              <Field
                label="VdW cutoff"
                type="number"
                value={String(gromacs.rvdw ?? "1.0")}
                onChange={(v) => onChange("gromacs.rvdw", Number(v))}
                onBlur={onSave}
                unit="nm"
              />
            </FieldGrid>
          </div>

          {/* Electrostatics */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Electrostatics</p>
            <FieldGrid>
              <SelectField
                label="Coulomb type"
                value={String(gromacs.coulombtype ?? "PME")}
                onChange={(v) => onChange("gromacs.coulombtype", v)}
                onSave={onSave}
                options={[
                  { value: "PME",     label: "PME"     },
                  { value: "cutoff",  label: "Cutoff"  },
                  { value: "Ewald",   label: "Ewald"   },
                ]}
              />
              <Field
                label="PME order"
                type="number"
                value={String(gromacs.pme_order ?? "4")}
                onChange={(v) => onChange("gromacs.pme_order", Number(v))}
                onBlur={onSave}
              />
              <Field
                label="Fourier spacing"
                type="number"
                value={String(gromacs.fourierspacing ?? "0.16")}
                onChange={(v) => onChange("gromacs.fourierspacing", Number(v))}
                onBlur={onSave}
                unit="nm"
              />
            </FieldGrid>
          </div>

          {/* Neighbor list */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Neighbor List</p>
            <FieldGrid>
              <SelectField
                label="Cutoff scheme"
                value={String(gromacs.cutoff_scheme ?? "Verlet")}
                onChange={(v) => onChange("gromacs.cutoff_scheme", v)}
                onSave={onSave}
                options={[
                  { value: "Verlet", label: "Verlet" },
                  { value: "group",  label: "Group"  },
                ]}
              />
              <Field
                label="nstlist"
                type="number"
                value={String(gromacs.nstlist ?? "10")}
                onChange={(v) => onChange("gromacs.nstlist", Number(v))}
                onBlur={onSave}
                hint="Steps between neighbor list updates."
              />
            </FieldGrid>
          </div>

          {/* Constraints */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Constraints</p>
            <FieldGrid>
              <SelectField
                label="Constraints"
                value={String(gromacs.constraints ?? "h-bonds")}
                onChange={(v) => onChange("gromacs.constraints", v)}
                onSave={onSave}
                options={[
                  { value: "h-bonds",  label: "H-bonds"  },
                  { value: "all-bonds", label: "All bonds" },
                  { value: "none",     label: "None"     },
                ]}
              />
              <SelectField
                label="Algorithm"
                value={String(gromacs.constraint_algorithm ?? "LINCS")}
                onChange={(v) => onChange("gromacs.constraint_algorithm", v)}
                onSave={onSave}
                options={[
                  { value: "LINCS",  label: "LINCS"  },
                  { value: "SHAKE",  label: "SHAKE"  },
                ]}
              />
            </FieldGrid>
          </div>

          {/* Output frequencies */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Output Frequencies (steps)</p>
            <FieldGrid>
              <Field
                label="nstxout"
                type="number"
                value={String(gromacs.nstxout ?? "5000")}
                onChange={(v) => onChange("gromacs.nstxout", Number(v))}
                onBlur={onSave}
                hint="Coordinates to .trr"
              />
              <Field
                label="nstvout"
                type="number"
                value={String(gromacs.nstvout ?? "5000")}
                onChange={(v) => onChange("gromacs.nstvout", Number(v))}
                onBlur={onSave}
                hint="Velocities to .trr"
              />
              <Field
                label="nstfout"
                type="number"
                value={String(gromacs.nstfout ?? "0")}
                onChange={(v) => onChange("gromacs.nstfout", Number(v))}
                onBlur={onSave}
                hint="Forces to .trr (0 = off)"
              />
              <Field
                label="nstlog"
                type="number"
                value={String(gromacs.nstlog ?? "1000")}
                onChange={(v) => onChange("gromacs.nstlog", Number(v))}
                onBlur={onSave}
                hint="Energy to .log"
              />
              <Field
                label="nstxout-compressed"
                type="number"
                value={String(gromacs.nstxout_compressed ?? "10")}
                onChange={(v) => onChange("gromacs.nstxout_compressed", Number(v))}
                onBlur={onSave}
                hint="Coordinates to .xtc"
              />
              <Field
                label="nstenergy"
                type="number"
                value={String(gromacs.nstenergy ?? "1000")}
                onChange={(v) => onChange("gromacs.nstenergy", Number(v))}
                onBlur={onSave}
                hint="Energy to .edr"
              />
            </FieldGrid>
          </div>

          {/* Pressure */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Pressure Coupling</p>
            <FieldGrid>
              <SelectField
                label="Barostat"
                value={String(gromacs.pcoupl ?? "no")}
                onChange={(v) => onChange("gromacs.pcoupl", v)}
                onSave={onSave}
                options={[
                  { value: "no",                label: "None"               },
                  { value: "Parrinello-Rahman",  label: "Parrinello-Rahman"  },
                  { value: "Berendsen",          label: "Berendsen"          },
                  { value: "C-rescale",          label: "C-rescale"          },
                ]}
              />
              <Field
                label="Reference pressure"
                type="number"
                value={String(gromacs.ref_p ?? gromacs.pressure ?? "1.0")}
                onChange={(v) => onChange("gromacs.ref_p", Number(v))}
                onBlur={onSave}
                unit="bar"
              />
              <Field
                label="τ pressure"
                type="number"
                value={String(gromacs.tau_p ?? "2.0")}
                onChange={(v) => onChange("gromacs.tau_p", Number(v))}
                onBlur={onSave}
                unit="ps"
              />
            </FieldGrid>
          </div>
        </div>
        </fieldset>
      )}
    </div>
  );
}

// ── CV type options ──────────────────────────────────────────────────
const CV_TYPES = [
  { value: "DISTANCE", label: "Distance" },
  { value: "TORSION", label: "Torsion" },
  { value: "ANGLE", label: "Angle" },
  { value: "RMSD", label: "RMSD" },
  { value: "COORDINATION", label: "Coordination" },
];

interface CVDefinition {
  name: string;
  type: string;
  atoms?: number[];
  reference?: string;
  rmsd_type?: string;
  groupa?: number[];
  groupb?: number[];
  r0?: number;
}

function CVEditor({
  cv,
  index,
  onChange,
  onRemove,
}: {
  cv: CVDefinition;
  index: number;
  onChange: (updated: CVDefinition) => void;
  onRemove: () => void;
}) {
  const needsAtoms = ["DISTANCE", "TORSION", "ANGLE"].includes(cv.type);
  const atomCount = cv.type === "DISTANCE" ? 2 : cv.type === "TORSION" ? 4 : cv.type === "ANGLE" ? 3 : 0;

  return (
    <div className="rounded-lg border border-gray-300/50 dark:border-gray-700/50 bg-gray-100/30 dark:bg-gray-800/30 p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">CV {index + 1}</span>
          <span className="text-[10px] font-mono text-gray-400 dark:text-gray-600">{cv.type}</span>
        </div>
        <button onClick={onRemove} className="p-0.5 rounded text-gray-400 dark:text-gray-600 hover:text-red-400 hover:bg-red-100/20 dark:hover:bg-red-900/20 transition-colors">
          <Trash2 size={11} />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="text-xs font-medium text-gray-500 mb-1 block">Name</label>
          <input
            value={cv.name}
            onChange={(e) => onChange({ ...cv, name: e.target.value })}
            className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="d1"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 mb-1 block">Type</label>
          <select
            value={cv.type}
            onChange={(e) => {
              const v = e.target.value;
              onChange({ ...cv, type: v, atoms: [] });
            }}
            className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {CV_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        {needsAtoms && (
          <div>
            <label className="text-xs font-medium text-gray-500 mb-1 block">Atoms ({atomCount})</label>
            <input
              value={(cv.atoms ?? []).join(",")}
              onChange={(e) => {
                const parsed = e.target.value.split(/[,\s]+/).map(Number).filter((n) => !isNaN(n));
                onChange({ ...cv, atoms: parsed });
              }}
              className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder={cv.type === "TORSION" ? "5,7,9,15" : "1,100"}
            />
          </div>
        )}
        {cv.type === "RMSD" && (
          <div>
            <label className="text-xs font-medium text-gray-500 mb-1 block">Reference</label>
            <input
              value={cv.reference ?? ""}
              onChange={(e) => onChange({ ...cv, reference: e.target.value })}
              className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="reference.pdb"
            />
          </div>
        )}
      </div>
    </div>
  );
}


// ── Method tab (includes PLUMED) ────────────────────────────────────────

const METHOD_OPTIONS = [
  { id: "md",       label: "MD",         long: "Molecular Dynamics" },
  { id: "metad",    label: "MetaD",      long: "Well-tempered Metadynamics" },
  { id: "opes",     label: "OPES",       long: "On-the-fly Probability Enhanced Sampling" },
  { id: "umbrella", label: "Umbrella",   long: "Umbrella Sampling" },
  { id: "steered",  label: "Steered",    long: "Steered MD" },
];

function MethodTab({
  sessionId,
  cfg,
  onChange,
  onSave,
  runStatus,
}: {
  sessionId: string;
  cfg: Record<string, unknown>;
  onChange: (k: string, v: unknown) => void;
  onSave: () => void;
  runStatus: "standby" | "running" | "finished" | "failed" | "paused";
}) {
  const method = (cfg.method ?? {}) as Record<string, unknown>;
  const hills = (method.hills ?? {}) as Record<string, unknown>;
  const plumedCfg = (cfg.plumed ?? {}) as Record<string, unknown>;
  const cvsCfg = (plumedCfg.collective_variables ?? {}) as Record<string, unknown>;
  const [agentOpen, setAgentOpen] = useState(false);
  const [cvMode, setCvMode] = useState<"manual" | "mlcv">("manual");
  const [mlCheckpoints, setMlCheckpoints] = useState<string[]>([]);
  const [mlSelectedCkpt, setMlSelectedCkpt] = useState<string>(
    String((cvsCfg as Record<string, unknown>).mlcv_checkpoint ?? "")
  );
  const [mlInputCvs, setMlInputCvs] = useState<Set<number>>(new Set());
  const [ckptValidation, setCkptValidation] = useState<Record<string, { valid: boolean; is_jit: boolean; n_inputs: number | null; n_outputs: number | null; error: string | null }>>({});
  const [ckptValidating, setCkptValidating] = useState<string | null>(null);
  const [plumedPreview, setPlumedPreview] = useState<string | null>(null);
  const [plumedLoading, setPlumedLoading] = useState(false);
  const [plumedMessage, setPlumedMessage] = useState<string | null>(null);
  const [pdbFiles, setPdbFiles] = useState<string[]>([]);
  const [initialContent, setInitialContent] = useState<string | null>(null);
  const [targetContent, setTargetContent] = useState<string | null>(null);
  const [plumedRevision, setPlumedRevision] = useState(0);
  const [plumedPopupOpen, setPlumedPopupOpen] = useState(false);
  const isLocked = runStatus === "running" || runStatus === "finished";

  // Load PDB/structure files for steered MD initial/target selection
  const [fileRefreshKey, setFileRefreshKey] = useState(0);
  useEffect(() => {
    listFiles(sessionId).then(({ files }) => {
      const structs = files.filter((f) => {
        const ext = f.split(".").pop()?.toLowerCase() ?? "";
        return ["pdb", "gro", "mol2", "xyz", "sdf"].includes(ext);
      }).map((f) => f.split("/").pop() ?? f);
      setPdbFiles(structs);
      // Scan for ML checkpoint files (.pt, .ckpt, .pth)
      const ckpts = files.filter((f) => {
        const ext = f.split(".").pop()?.toLowerCase() ?? "";
        return ["pt", "ckpt", "pth"].includes(ext);
      }).map((f) => f.split("/").pop() ?? f);
      setMlCheckpoints(ckpts);
      // Clear selection if the selected checkpoint was deleted
      if (mlSelectedCkpt && !ckpts.includes(mlSelectedCkpt)) {
        setMlSelectedCkpt("");
        onChange("plumed.collective_variables.mlcv_checkpoint", "");
        saveAndRefreshPlumed();
      }
    }).catch(() => {});
  }, [sessionId, fileRefreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load structure content for steered MD viewers
  const initialPdb = String(method.initial_pdb ?? "");
  const targetPdb = String(method.target_pdb ?? "");
  useEffect(() => {
    if (!initialPdb) { setInitialContent(null); return; }
    getFileContent(sessionId, initialPdb).then(setInitialContent).catch(() => setInitialContent(null));
  }, [sessionId, initialPdb]);
  useEffect(() => {
    if (!targetPdb) { setTargetContent(null); return; }
    getFileContent(sessionId, targetPdb).then(setTargetContent).catch(() => setTargetContent(null));
  }, [sessionId, targetPdb]);

  const currentMethodId = (method._target_name as string) ?? "md";
  const currentMethod = METHOD_OPTIONS.find((m) => m.id === currentMethodId) ?? METHOD_OPTIONS[0];
  const isMetaD = currentMethodId === "metad" || currentMethodId === "metadynamics";
  const isOpes = currentMethodId === "opes";
  const isUmbrella = currentMethodId === "umbrella" || currentMethodId === "umbrella_sampling";
  const isSteered = currentMethodId === "steered" || currentMethodId === "steered_md";
  const needsPlumed = isMetaD || isOpes || isUmbrella || isSteered;

  // Auto-load PLUMED preview — refreshes on method/session change and after config saves
  useEffect(() => {
    if (!needsPlumed) { setPlumedPreview(null); return; }
    // Debounce to avoid spamming API on rapid saves
    const timer = setTimeout(() => {
      setPlumedLoading(true);
      getPlumedPreview(sessionId)
        .then((res) => { setPlumedPreview(res.content ?? null); setPlumedMessage(res.content ? null : (res.message ?? null)); })
        .catch(() => { setPlumedPreview(null); })
        .finally(() => setPlumedLoading(false));
    }, plumedRevision === 0 ? 0 : 400);
    return () => clearTimeout(timer);
  }, [sessionId, needsPlumed, plumedRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wrap onSave to also trigger PLUMED preview refresh
  const saveAndRefreshPlumed = () => {
    onSave();
    if (needsPlumed) setPlumedRevision((r) => r + 1);
  };

  // Parse CVs from config — always available regardless of method
  const rawCvs = (cvsCfg.cvs ?? []) as CVDefinition[];
  const cvs: CVDefinition[] = Array.isArray(rawCvs) ? rawCvs : [];

  // Auto-save and refresh plumed preview when CVs change (debounced)
  const cvsLenRef = useRef(cvs.length);
  const cvsAtomsRef = useRef("");
  useEffect(() => {
    // Build a lightweight fingerprint instead of JSON.stringify (avoids circular ref crashes)
    const fp = cvs.map((c) => `${c.name}|${c.type}|${(c.atoms ?? []).join(",")}`).join(";");
    if (fp === cvsAtomsRef.current && cvs.length === cvsLenRef.current) return;
    cvsAtomsRef.current = fp;
    cvsLenRef.current = cvs.length;
    const timer = setTimeout(() => {
      onSave();
      if (needsPlumed) setPlumedRevision((r) => r + 1);
    }, 600);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cvs]);

  const handleMethodChange = (id: string) => {
    if (isLocked) return;
    onChange("method._target_name", id);
    saveAndRefreshPlumed();
  };

  const handleCVChange = (index: number, updated: CVDefinition) => {
    const newCvs = [...cvs];
    newCvs[index] = updated;
    onChange("plumed.collective_variables.cvs", newCvs);
  };

  const handleCVRemove = (index: number) => {
    const newCvs = cvs.filter((_, i) => i !== index);
    onChange("plumed.collective_variables.cvs", newCvs);
    saveAndRefreshPlumed();
  };

  const handleCVAdd = () => {
    const newCv: CVDefinition = { name: `cv${cvs.length + 1}`, type: "DISTANCE", atoms: [] };
    onChange("plumed.collective_variables.cvs", [...cvs, newCv]);
    saveAndRefreshPlumed();
  };

  const handleToggleCkpt = async (ckpt: string) => {
    // Deselect
    if (mlSelectedCkpt === ckpt) {
      setMlSelectedCkpt("");
      onChange("plumed.collective_variables.mlcv_checkpoint", "");
      onChange("plumed.collective_variables.mlcv_n_outputs", null);
      saveAndRefreshPlumed();
      return;
    }
    // Validate before selecting
    setCkptValidating(ckpt);
    try {
      const res = await validateCheckpoint(sessionId, ckpt);
      setCkptValidation((v) => ({ ...v, [ckpt]: res }));
      if (res.valid) {
        setMlSelectedCkpt(ckpt);
        onChange("plumed.collective_variables.mlcv_checkpoint", ckpt);
        // Store n_outputs so backend can generate correct PLUMED without torch
        if (res.n_outputs != null) {
          onChange("plumed.collective_variables.mlcv_n_outputs", res.n_outputs);
        }
        saveAndRefreshPlumed();
      }
    } catch {
      setCkptValidation((v) => ({ ...v, [ckpt]: { valid: false, is_jit: false, n_inputs: null, n_outputs: null, error: "Validation request failed" } }));
    } finally {
      setCkptValidating(null);
    }
  };

  const handleDeleteCkpt = async (ckpt: string) => {
    try {
      await deleteFile(sessionId, ckpt);
    } catch { /* ignore */ }
    if (mlSelectedCkpt === ckpt) {
      setMlSelectedCkpt("");
      onChange("plumed.collective_variables.mlcv_checkpoint", "");
      saveAndRefreshPlumed();
    }
    setFileRefreshKey((n) => n + 1);
  };

  const handlePreviewPlumed = async () => {
    setPlumedLoading(true);
    setPlumedMessage(null);
    try {
      const res = await getPlumedPreview(sessionId);
      if (res.content) {
        setPlumedPreview(res.content);
      } else {
        setPlumedPreview(null);
        setPlumedMessage(res.message ?? "Could not generate preview.");
      }
    } catch (err: unknown) {
      setPlumedMessage(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setPlumedLoading(false);
    }
  };

  const handleGeneratePlumed = async () => {
    setPlumedLoading(true);
    setPlumedMessage(null);
    try {
      await generatePlumedFile(sessionId);
      setPlumedMessage("plumed.dat written to session directory.");
    } catch (err: unknown) {
      setPlumedMessage(err instanceof Error ? err.message : "Generation failed.");
    } finally {
      setPlumedLoading(false);
    }
  };

  return (
    <div className="p-3 space-y-3">
      <div className="sticky top-0 z-20 -mx-3 px-3 py-1.5 bg-gray-50/95 dark:bg-gray-950/95 backdrop-blur border-b border-gray-200/80 dark:border-gray-800/80">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">
            <span className="text-gray-500 dark:text-gray-400 font-normal">{currentMethod.long}</span> — {currentMethod.label}
          </h3>
          <div className="flex items-center gap-2">
            {needsPlumed && !isLocked && (
              <button
                onClick={() => setAgentOpen(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200/60 dark:border-indigo-800/50 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-800/40 transition-colors"
              >
                <Bot size={11} />
                Suggest CVs
              </button>
            )}
            {needsPlumed && (
              <button
                onClick={() => { handlePreviewPlumed(); setPlumedPopupOpen(true); }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-amber-50 dark:bg-amber-900/30 border border-amber-200/60 dark:border-amber-800/50 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-800/40 transition-colors"
              >
                <FileText size={11} />
                Preview PLUMED
              </button>
            )}
            {isLocked && (
              <span className="inline-flex items-center gap-1 text-xs text-amber-400">
                <Lock size={11} />
                Locked
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Method toggle — horizontal buttons */}
      <fieldset disabled={isLocked} className={isLocked ? "opacity-60" : ""}>
        <div className="flex rounded-lg border border-gray-300 dark:border-gray-700 overflow-hidden h-[32px]">
          {METHOD_OPTIONS.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onClick={() => handleMethodChange(m.id)}
              title={m.long}
              className={`flex-1 flex items-center justify-center text-xs font-medium transition-colors ${
                m.id === currentMethodId
                  ? "bg-indigo-100/50 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-300"
                  : "bg-gray-100/40 dark:bg-gray-800/40 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800"
              } ${i < METHOD_OPTIONS.length - 1 ? "border-r border-gray-300 dark:border-gray-700" : ""}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </fieldset>

      {/* Method-specific parameters + COLVAR output — combined section above CVs */}
      {isMetaD && (
        <fieldset disabled={isLocked} className={isLocked ? "opacity-60" : ""}>
        <Section icon={<Mountain size={11} />} title="Metadynamics" accent="indigo">
          <div className="grid grid-cols-2 gap-2 mb-2">
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Stride <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">steps</span></label>
              <input type="number" value={String(cvsCfg.colvar_stride ?? 100)} onChange={(e) => onChange("plumed.collective_variables.colvar_stride", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1 h-[22px]">Filename</label>
              <input value={String(cvsCfg.colvar_file ?? "COLVAR")} onChange={(e) => onChange("plumed.collective_variables.colvar_file", e.target.value)} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>
          <div className="h-px bg-gray-200 dark:bg-gray-800 my-2" />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Height <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">kJ/mol</span></label>
              <input type="number" step="any" value={String(hills.height ?? "")} onChange={(e) => onChange("method.hills.height", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Pace <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">steps</span></label>
              <input type="number" value={String(hills.pace ?? "")} onChange={(e) => onChange("method.hills.pace", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Sigma <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">CV units</span></label>
              <input type="number" step="any" value={String(Array.isArray(hills.sigma) ? hills.sigma[0] : hills.sigma ?? "")} onChange={(e) => onChange("method.hills.sigma", [Number(e.target.value)])} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Bias factor <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">γ</span></label>
              <input type="number" step="any" value={String(hills.biasfactor ?? "")} onChange={(e) => onChange("method.hills.biasfactor", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Temperature <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">K</span></label>
              <input type="number" step="any" value={String(method.temperature ?? "")} onChange={(e) => onChange("method.temperature", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1 h-[22px]">HILLS file</label>
              <input value={String(hills.hills_file ?? "HILLS")} onChange={(e) => onChange("method.hills.hills_file", e.target.value)} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-600 mt-1">Well-tempered: set γ 5–15 + temperature. Leave empty for standard MetaD.</p>
        </Section>
        </fieldset>
      )}

      {isOpes && (
        <fieldset disabled={isLocked} className={isLocked ? "opacity-60" : ""}>
        <Section icon={<Mountain size={11} />} title="OPES Parameters" accent="indigo">
          <div className="grid grid-cols-2 gap-2 mb-2">
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Stride <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">steps</span></label>
              <input type="number" value={String(cvsCfg.colvar_stride ?? 100)} onChange={(e) => onChange("plumed.collective_variables.colvar_stride", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1 h-[22px]">COLVAR file</label>
              <input value={String(cvsCfg.colvar_file ?? "COLVAR")} onChange={(e) => onChange("plumed.collective_variables.colvar_file", e.target.value)} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>
          <div className="h-px bg-gray-200 dark:bg-gray-800 my-2" />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Pace <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">steps</span></label>
              <input type="number" value={String(method.pace ?? 500)} onChange={(e) => onChange("method.pace", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1 h-[22px]">Sigma</label>
              <input type="number" step="any" value={String(method.sigma ?? 0.05)} onChange={(e) => onChange("method.sigma", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Barrier <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">kJ/mol</span></label>
              <input type="number" step="any" value={String(method.barrier ?? 30)} onChange={(e) => onChange("method.barrier", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Temperature <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">K</span></label>
              <input type="number" step="any" value={String(method.temperature ?? 340)} onChange={(e) => onChange("method.temperature", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>
          <div className="h-px bg-gray-200 dark:bg-gray-800 my-2" />
          <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1.5">Output Files</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1 h-[22px]">Kernels file</label>
              <input value={String(method.kernels_file ?? "KERNELS")} onChange={(e) => onChange("method.kernels_file", e.target.value)} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1 h-[22px]">State file</label>
              <input value={String(method.state_wfile ?? "STATE")} onChange={(e) => onChange("method.state_wfile", e.target.value)} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">State write stride <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">steps</span></label>
              <input type="number" value={String(method.state_wstride ?? 500000)} onChange={(e) => onChange("method.state_wstride", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1 h-[22px]">Store states</label>
              <div className="flex items-center h-[30px]">
                <button
                  type="button"
                  onClick={() => { onChange("method.store_states", !(method.store_states ?? true)); saveAndRefreshPlumed(); }}
                  className={`relative w-9 h-5 rounded-full transition-colors duration-200 ${
                    (method.store_states ?? true) ? "bg-indigo-600" : "bg-gray-300 dark:bg-gray-700"
                  }`}
                >
                  <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-[left] duration-200" style={{ left: (method.store_states ?? true) ? "18px" : "2px" }} />
                </button>
                <span className="ml-2 text-xs text-gray-500">{(method.store_states ?? true) ? "On" : "Off"}</span>
              </div>
            </div>
          </div>
        </Section>
        </fieldset>
      )}

      {isUmbrella && (
        <fieldset disabled={isLocked} className={isLocked ? "opacity-60" : ""}>
        <Section icon={<Mountain size={11} />} title="Umbrella Sampling" accent="indigo">
          <div className="grid grid-cols-2 gap-2 mb-2">
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Stride <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">steps</span></label>
              <input type="number" value={String(cvsCfg.colvar_stride ?? 100)} onChange={(e) => onChange("plumed.collective_variables.colvar_stride", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1 h-[22px]">Filename</label>
              <input value={String(cvsCfg.colvar_file ?? "COLVAR")} onChange={(e) => onChange("plumed.collective_variables.colvar_file", e.target.value)} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>
          <div className="h-px bg-gray-200 dark:bg-gray-800 my-2" />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Window start <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">nm</span></label>
              <input type="number" step="any" value={String(method.window_start ?? 0)} onChange={(e) => onChange("method.window_start", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Window end <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">nm</span></label>
              <input type="number" step="any" value={String(method.window_end ?? 4.0)} onChange={(e) => onChange("method.window_end", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Spacing <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">nm</span></label>
              <input type="number" step="any" value={String(method.window_spacing ?? 0.2)} onChange={(e) => onChange("method.window_spacing", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Force κ <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">kJ/mol/nm²</span></label>
              <input type="number" step="any" value={String(method.force_constant ?? 1000)} onChange={(e) => onChange("method.force_constant", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>
        </Section>
        </fieldset>
      )}

      {/* Collective Variables — always shown for PLUMED methods */}
      {needsPlumed && (
        <Section icon={<Search size={11} />} title={`Collective Variables (${cvs.length})`} accent="emerald">
          {/* Descriptors / MLCVs toggle — always interactive even when locked */}
          <div className="flex rounded-lg border border-gray-300 dark:border-gray-700 overflow-hidden h-[30px] mb-3">
            <button
              type="button"
              onClick={() => setCvMode("manual")}
              className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-medium transition-colors ${
                cvMode === "manual"
                  ? "bg-emerald-100/50 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400"
                  : "bg-gray-100/40 dark:bg-gray-800/40 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800"
              } border-r border-gray-300 dark:border-gray-700`}
            >
              <FlaskConical size={11} />
              Descriptors
            </button>
            <button
              type="button"
              onClick={() => setCvMode("mlcv")}
              className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-medium transition-colors ${
                cvMode === "mlcv"
                  ? "bg-violet-100/50 dark:bg-violet-900/40 text-violet-600 dark:text-violet-400"
                  : "bg-gray-100/40 dark:bg-gray-800/40 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800"
              }`}
            >
              <Layers size={11} />
              MLCVs
            </button>
          </div>

          <fieldset disabled={isLocked} className={isLocked ? "opacity-60" : ""}>
          {cvMode === "manual" ? (
            /* Interactive 3D atom picker — inline, synced with config */
            <InlineCVPicker
              sessionId={sessionId}
              cvs={cvs as import("@/components/viz/InlineCVPicker").ConfigCV[]}
              onChange={(updated) => {
                onChange("plumed.collective_variables.cvs", updated);
              }}
            />
          ) : (
            /* MLCVs — checkpoint upload (left, same size as 3D viewer) + input descriptors (right) */
            <div className="flex gap-4">
              {/* Left: Checkpoint files — same size as the 3D viewer in Descriptors */}
              <div className="flex flex-col flex-shrink-0 rounded-xl border border-gray-300/60 dark:border-gray-700/60 bg-gray-50/80 dark:bg-gray-900/50 overflow-hidden" style={{ width: "360px", height: "400px" }}>
                <div className="px-3 py-2 border-b border-gray-200/60 dark:border-gray-800 flex items-center justify-between">
                  <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Checkpoints</p>
                  <button
                    onClick={() => setFileRefreshKey((n) => n + 1)}
                    className="p-0.5 text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400 transition-colors"
                    title="Refresh checkpoints"
                  >
                    <RefreshCw size={11} />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-2 space-y-1" style={{ scrollbarWidth: "thin" }}>
                  {mlCheckpoints.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center px-2 gap-2">
                      <Upload size={16} className="text-gray-300 dark:text-gray-600" />
                      <p className="text-[9px] text-gray-400 dark:text-gray-600">No .pt / .ckpt / .pth files.<br />Upload below.</p>
                    </div>
                  ) : (
                    mlCheckpoints.map((ckpt) => {
                      const isSelected = mlSelectedCkpt === ckpt;
                      const isValidating = ckptValidating === ckpt;
                      const vResult = ckptValidation[ckpt];
                      const hasFailed = vResult && !vResult.valid;
                      const hasWarning = vResult?.valid && vResult.is_jit === null; // torch not available
                      return (
                        <div key={ckpt} className="space-y-0.5">
                          <div
                            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-colors text-[10px] group ${
                              isSelected
                                ? "bg-violet-100/50 dark:bg-violet-900/30 border border-violet-300/60 dark:border-violet-700/50 text-violet-700 dark:text-violet-300"
                                : hasFailed
                                  ? "bg-red-50/50 dark:bg-red-900/20 border border-red-300/60 dark:border-red-800/50 text-red-600 dark:text-red-400"
                                  : "bg-white/40 dark:bg-gray-800/30 border border-gray-200/60 dark:border-gray-800 text-gray-600 dark:text-gray-400"
                            }`}
                          >
                            <Archive size={10} className="flex-shrink-0" />
                            <span className="font-mono truncate flex-1 min-w-0">{ckpt}</span>
                            <div className="flex items-center gap-0.5 flex-shrink-0">
                              {/* Validation info badge */}
                              {isSelected && vResult?.valid && !hasWarning && (
                                <span className="px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 text-[8px] font-medium whitespace-nowrap">
                                  JIT {vResult.n_inputs != null ? `${vResult.n_inputs}→${vResult.n_outputs}` : ""}
                                </span>
                              )}
                              {isSelected && hasWarning && (
                                <span className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 text-[8px] font-medium whitespace-nowrap">
                                  Unverified
                                </span>
                              )}
                              <button
                                onClick={() => handleToggleCkpt(ckpt)}
                                disabled={isValidating}
                                title={isSelected ? "Deselect checkpoint" : "Validate & use this checkpoint"}
                                className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors ${
                                  isSelected
                                    ? "bg-violet-500 text-white hover:bg-violet-600"
                                    : "bg-gray-100 dark:bg-gray-800 text-gray-500 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30"
                                } disabled:opacity-50`}
                              >
                                {isValidating ? <Loader2 size={9} className="animate-spin" /> : isSelected ? "Active" : "Select"}
                              </button>
                              <button
                                onClick={() => handleDeleteCkpt(ckpt)}
                                title="Delete checkpoint"
                                className="p-0.5 rounded text-gray-400 dark:text-gray-600 hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors opacity-0 group-hover:opacity-100"
                              >
                                <Trash2 size={10} />
                              </button>
                            </div>
                          </div>
                          {/* Validation error message */}
                          {hasFailed && (
                            <div className="px-2 py-1 rounded bg-red-50 dark:bg-red-900/20 border border-red-200/40 dark:border-red-800/30">
                              <p className="text-[8px] text-red-500 dark:text-red-400 leading-relaxed">{vResult.error}</p>
                            </div>
                          )}
                          {/* Warning when torch is not available */}
                          {isSelected && hasWarning && vResult?.error && (
                            <div className="px-2 py-1 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200/40 dark:border-amber-800/30">
                              <p className="text-[8px] text-amber-500 dark:text-amber-400 leading-relaxed">{vResult.error}</p>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Upload area — accepts checkpoint files */}
                <div className="p-1.5 border-t border-gray-200/60 dark:border-gray-800 flex-shrink-0">
                  <FileUpload sessionId={sessionId} onUploaded={() => setFileRefreshKey((n) => n + 1)} accept={{ "application/octet-stream": [".pt", ".ckpt", ".pth"] }} label="Drop .pt/.ckpt/.pth" />
                </div>
              </div>

              {/* Right: Input CV selection from Descriptors */}
              <div className="flex-1 flex flex-col min-w-0 rounded-xl border border-gray-300/60 dark:border-gray-700/60 bg-gray-50/80 dark:bg-gray-900/50 overflow-hidden" style={{ height: "400px" }}>
                <div className="flex items-start justify-between px-3 py-2.5 border-b border-gray-200/60 dark:border-gray-800">
                  <div>
                    <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Input Descriptors</p>
                    <p className="text-[9px] text-gray-400 dark:text-gray-600 mt-0.5">Select CVs as input features for the MLCV model.</p>
                  </div>
                  {cvs.length > 0 && (
                    <button
                      onClick={() => {
                        const allSelected = cvs.length > 0 && cvs.every((_, i) => mlInputCvs.has(i));
                        setMlInputCvs(allSelected ? new Set() : new Set(cvs.map((_, i) => i)));
                      }}
                      className="flex-shrink-0 text-[9px] font-medium text-violet-600 dark:text-violet-400 hover:text-violet-500 dark:hover:text-violet-300 transition-colors mt-0.5"
                    >
                      {cvs.length > 0 && cvs.every((_, i) => mlInputCvs.has(i)) ? "Deselect all" : "Select all"}
                    </button>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto p-2 space-y-1" style={{ scrollbarWidth: "thin" }}>
                  {cvs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center px-3 gap-2">
                      <Search size={16} className="text-gray-300 dark:text-gray-600" />
                      <p className="text-[10px] text-gray-400 dark:text-gray-600">No descriptors defined yet.<br />Switch to Descriptors tab first.</p>
                    </div>
                  ) : (
                    cvs.map((cv, i) => {
                      const selected = mlInputCvs.has(i);
                      return (
                        <button
                          key={i}
                          onClick={() => setMlInputCvs((prev) => {
                            const next = new Set(prev);
                            next.has(i) ? next.delete(i) : next.add(i);
                            return next;
                          })}
                          className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-colors text-xs ${
                            selected
                              ? "bg-violet-100/50 dark:bg-violet-900/30 border border-violet-300/60 dark:border-violet-700/50 text-violet-700 dark:text-violet-300"
                              : "bg-white/40 dark:bg-gray-800/30 border border-gray-200/60 dark:border-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100/60 dark:hover:bg-gray-800/50"
                          }`}
                        >
                          <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                            selected ? "bg-violet-500 border-violet-500" : "border-gray-300 dark:border-gray-600"
                          }`}>
                            {selected && <CheckCircle2 size={9} className="text-white" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <span className="font-mono text-[11px]">{cv.name}</span>
                            <span className="text-[9px] text-gray-400 dark:text-gray-600 ml-1.5">{cv.type}</span>
                          </div>
                          {cv.atoms && cv.atoms.length > 0 && (
                            <span className="text-[9px] text-gray-400 dark:text-gray-600 font-mono">[{cv.atoms.join(",")}]</span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>

                <div className="px-2 py-2 border-t border-gray-200/60 dark:border-gray-800 flex-shrink-0">
                  <div className="flex items-center justify-between">
                    <div className="text-[9px] text-gray-400 dark:text-gray-600">
                      {mlInputCvs.size > 0 ? `${mlInputCvs.size} descriptor${mlInputCvs.size > 1 ? "s" : ""} selected` : "No descriptors selected"}
                      {mlSelectedCkpt ? ` · ${mlSelectedCkpt}` : ""}
                    </div>
                    {mlInputCvs.size > 0 && !isLocked && (
                      <button
                        onClick={() => {
                          const remaining = cvs.filter((_, i) => !mlInputCvs.has(i));
                          onChange("plumed.collective_variables.cvs", remaining);
                          setMlInputCvs(new Set());
                          saveAndRefreshPlumed();
                        }}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[9px] font-medium border border-red-200/60 dark:border-red-800/50 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
                      >
                        <Trash2 size={9} />
                        Delete ({mlInputCvs.size})
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          </fieldset>
        </Section>
      )}

      {isSteered && (
        <fieldset disabled={isLocked} className={isLocked ? "opacity-60" : ""}>
        <Section icon={<Mountain size={11} />} title="Steered MD" accent="indigo">
          <div className="grid grid-cols-2 gap-2 mb-2">
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Stride <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">steps</span></label>
              <input type="number" value={String(cvsCfg.colvar_stride ?? 100)} onChange={(e) => onChange("plumed.collective_variables.colvar_stride", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1 h-[22px]">Filename</label>
              <input value={String(cvsCfg.colvar_file ?? "COLVAR")} onChange={(e) => onChange("plumed.collective_variables.colvar_file", e.target.value)} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>
          <div className="h-px bg-gray-200 dark:bg-gray-800 my-2" />
          {/* Initial & Target state — viewers + selectors side by side */}
          <div className="flex items-stretch gap-2 mb-3">
            {/* Initial State */}
            <div className="flex-1 min-w-0 rounded-lg border border-gray-300/60 dark:border-gray-700/60 bg-gray-100/30 dark:bg-gray-800/30 p-2.5 space-y-2">
              <label className="text-[10px] font-semibold text-indigo-500 dark:text-indigo-400 uppercase tracking-wider block">Initial State (A)</label>
              {initialContent ? (
                <MiniStructureViewer fileContent={initialContent} fileName={initialPdb} height={160} />
              ) : (
                <div className="h-[160px] rounded-lg border border-dashed border-gray-300/60 dark:border-gray-700/60 bg-gray-50/40 dark:bg-gray-900/40 flex items-center justify-center">
                  <span className="text-[10px] text-gray-400 dark:text-gray-600">No structure selected</span>
                </div>
              )}
              <select
                value={initialPdb}
                onChange={(e) => { onChange("method.initial_pdb", e.target.value); saveAndRefreshPlumed(); }}
                className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                <option value="">Select structure…</option>
                {pdbFiles.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>
            {/* Arrow between states */}
            <div className="flex flex-col items-center justify-center flex-shrink-0 w-6">
              <div className="h-8 w-px bg-gradient-to-b from-indigo-600 to-amber-600" />
              <ChevronRight size={14} className="text-amber-500 my-0.5" />
              <div className="h-8 w-px bg-gradient-to-b from-amber-600/40 to-transparent" />
            </div>
            {/* Target State */}
            <div className="flex-1 min-w-0 rounded-lg border border-gray-300/60 dark:border-gray-700/60 bg-gray-100/30 dark:bg-gray-800/30 p-2.5 space-y-2">
              <label className="text-[10px] font-semibold text-amber-500 dark:text-amber-400 uppercase tracking-wider block">Target State (B)</label>
              {targetContent ? (
                <MiniStructureViewer fileContent={targetContent} fileName={targetPdb} height={160} />
              ) : (
                <div className="h-[160px] rounded-lg border border-dashed border-gray-300/60 dark:border-gray-700/60 bg-gray-50/40 dark:bg-gray-900/40 flex items-center justify-center">
                  <span className="text-[10px] text-gray-400 dark:text-gray-600">No structure selected</span>
                </div>
              )}
              <select
                value={targetPdb}
                onChange={(e) => { onChange("method.target_pdb", e.target.value); saveAndRefreshPlumed(); }}
                className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-amber-500"
              >
                <option value="">Select structure…</option>
                {pdbFiles.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>
          </div>
          {/* Steered MD parameters */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1 h-[22px]">Initial value</label>
              <input type="number" step="any" value={String(method.initial_value ?? 0)} onChange={(e) => onChange("method.initial_value", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1 h-[22px]">Final value</label>
              <input type="number" step="any" value={String(method.final_value ?? 4.0)} onChange={(e) => onChange("method.final_value", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Force κ <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">kJ/mol/nm²</span></label>
              <input type="number" step="any" value={String(method.force_constant ?? 500)} onChange={(e) => onChange("method.force_constant", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-gray-500 mb-1 h-[22px]">Pull rate <span className="text-xs font-mono text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">nm/ps</span></label>
              <input type="number" step="any" value={String(method.pull_rate ?? 0.005)} onChange={(e) => onChange("method.pull_rate", Number(e.target.value))} onBlur={saveAndRefreshPlumed} className="w-full border border-gray-300 dark:border-gray-700 rounded-md px-2 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>
        </Section>
        </fieldset>
      )}

      {/* PLUMED preview popup modal */}
      {plumedPopupOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setPlumedPopupOpen(false)} />
          <div className="relative w-[560px] max-h-[80vh] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-lg bg-amber-100 dark:bg-amber-900/40">
                  <FileText size={14} className="text-amber-600 dark:text-amber-400" />
                </div>
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">PLUMED Input File</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handlePreviewPlumed}
                  disabled={plumedLoading}
                  title="Refresh preview"
                  className="p-1.5 rounded-lg text-gray-400 hover:text-amber-500 dark:hover:text-amber-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
                >
                  {plumedLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                </button>
                <button
                  onClick={() => {
                    if (!plumedPreview) return;
                    const blob = new Blob([plumedPreview], { type: "text/plain" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "plumed.dat";
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  disabled={!plumedPreview}
                  title="Download plumed.dat"
                  className="p-1.5 rounded-lg text-gray-400 hover:text-emerald-500 dark:hover:text-emerald-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
                >
                  <Download size={14} />
                </button>
                <button
                  onClick={() => {
                    handleGeneratePlumed();
                  }}
                  disabled={plumedLoading || isLocked}
                  title="Write plumed.dat to session"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200/60 dark:border-emerald-800/50 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-800/40 transition-colors disabled:opacity-50"
                >
                  Generate
                </button>
                <button
                  onClick={() => setPlumedPopupOpen(false)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5">
              {plumedLoading ? (
                <div className="flex items-center justify-center py-12 text-gray-500">
                  <Loader2 size={16} className="animate-spin mr-2" />
                  <span className="text-sm">Generating preview…</span>
                </div>
              ) : plumedPreview ? (
                <pre className="text-[11px] leading-relaxed text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-xl p-4 overflow-x-auto font-mono whitespace-pre">
                  {plumedPreview}
                </pre>
              ) : (
                <div className="py-12 text-center">
                  <FileText size={24} className="mx-auto text-gray-300 dark:text-gray-700 mb-2" />
                  <p className="text-sm text-gray-400 dark:text-gray-600">{plumedMessage || "No PLUMED file generated yet."}</p>
                  <p className="text-xs text-gray-400 dark:text-gray-600 mt-1">Define collective variables and method parameters first.</p>
                </div>
              )}
              {plumedMessage && plumedPreview && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-3">{plumedMessage}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Plain MD note */}
      {!needsPlumed && (
        <div className="rounded-xl border border-gray-300/40 dark:border-gray-700/40 bg-gray-50/30 dark:bg-gray-900/30 p-3 text-center">
          <p className="text-xs text-gray-400 dark:text-gray-600">
            No enhanced sampling for <span className="text-gray-600 dark:text-gray-400">{currentMethod.long}</span>. Standard unbiased MD will run.
          </p>
        </div>
      )}

      {agentOpen && (
        <AgentModal sessionId={sessionId} agentType="cv" onClose={() => setAgentOpen(false)} />
      )}
    </div>
  );
}

// ── New session form ───────────────────────────────────────────────────

function NewSessionForm({
  onCreated,
}: {
  onCreated: (id: string, workDir: string, nickname: string, seededFiles: string[]) => void;
}) {
  const [nickname, setNickname] = useState(defaultNickname);
  const [preset, setPreset] = useState("md");
  const [system, setSystem] = useState("ala_dipeptide");
  const [gromacs, setGromacs] = useState("vacuum");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const nick = nickname.trim() || defaultNickname();
    const user = getUsername() || "default";
    const workDir = `outputs/${user}/${nick}/data`;
    try {
      const { session_id, work_dir, nickname: savedNick, seeded_files } = await createSession({
        workDir,
        nickname: nick,
        username: user,
        preset,
        system,
        gromacs,
      });
      onCreated(session_id, work_dir, savedNick, seeded_files ?? []);
    } catch (err) {
      console.error("Session creation failed:", err);
      setError(briefError(err));
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full items-start justify-center p-6 overflow-y-auto">
      <div className="w-full max-w-4xl">
        <div className="mb-6 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 mb-3 shadow-lg">
            <FlaskConical size={22} className="text-white" />
          </div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">New Session</h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Nickname */}
          <div className="rounded-xl border border-gray-300/60 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-900/60 p-4">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
              Session name <span className="text-gray-400 dark:text-gray-600">(editable anytime)</span>
            </label>
            <input
              autoFocus
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder={defaultNickname()}
              className="w-full border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Three selectors side by side */}
          <div className="grid grid-cols-3 gap-3">

            {/* Molecule system */}
            <div className="rounded-xl border border-gray-300/60 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-900/60 p-3 flex flex-col gap-1.5">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Molecule System</p>
              {SYSTEMS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSystem(s.id)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg border transition-all ${
                    system === s.id
                      ? "border-indigo-600 bg-indigo-50/40 dark:bg-indigo-950/40 text-gray-900 dark:text-white"
                      : "border-gray-300/60 dark:border-gray-700/60 bg-gray-100/40 dark:bg-gray-800/40 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-600 hover:text-gray-800 dark:hover:text-gray-200"
                  }`}
                >
                  <span className="text-xs font-medium">{s.label}</span>
                  <p className="text-[10px] text-gray-400 dark:text-gray-600 mt-0.5 leading-snug">{s.description}</p>
                </button>
              ))}
            </div>

            {/* Simulation method */}
            <div className="rounded-xl border border-gray-300/60 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-900/60 p-3 flex flex-col gap-1.5">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Simulation Method</p>
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPreset(p.id)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg border transition-all ${
                    preset === p.id
                      ? "border-blue-600 bg-blue-50/40 dark:bg-blue-950/40 text-gray-900 dark:text-white"
                      : "border-gray-300/60 dark:border-gray-700/60 bg-gray-100/40 dark:bg-gray-800/40 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-600 hover:text-gray-800 dark:hover:text-gray-200"
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-medium leading-snug">{p.label}</span>
                    {p.tag && (
                      <span className={`text-[10px] font-mono px-1 py-0.5 rounded flex-shrink-0 ${
                        preset === p.id ? "bg-blue-200/60 dark:bg-blue-700/60 text-blue-700 dark:text-blue-200" : "bg-gray-200 dark:bg-gray-700 text-gray-500"
                      }`}>{p.tag}</span>
                    )}
                  </div>
                  <p className="text-[10px] text-gray-400 dark:text-gray-600 mt-0.5 leading-snug">{p.description}</p>
                </button>
              ))}
            </div>

            {/* GROMACS template */}
            <div className="rounded-xl border border-gray-300/60 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-900/60 p-3 flex flex-col gap-1.5">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">GROMACS Template</p>
              {GMX_TEMPLATES.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setGromacs(g.id)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg border transition-all ${
                    gromacs === g.id
                      ? "border-emerald-600 bg-emerald-50/40 dark:bg-emerald-950/40 text-gray-900 dark:text-white"
                      : "border-gray-300/60 dark:border-gray-700/60 bg-gray-100/40 dark:bg-gray-800/40 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-600 hover:text-gray-800 dark:hover:text-gray-200"
                  }`}
                >
                  <span className="text-xs font-medium">{g.label}</span>
                  <p className="text-[10px] text-gray-400 dark:text-gray-600 mt-0.5 leading-snug">{g.description}</p>
                </button>
              ))}
            </div>

          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-950/40 rounded-lg px-3 py-2 border border-red-800">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-50 text-white font-semibold rounded-xl transition-all text-sm shadow-lg shadow-blue-900/30"
          >
            {loading ? "Creating…" : "Create Session"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Main MDWorkspace ───────────────────────────────────────────────────

interface Props {
  sessionId: string | null;
  showNewForm: boolean;
  onSessionCreated: (id: string, workDir: string, nickname: string) => void;
  onNewSession: () => void;
}

type SimState = "standby" | "running";

export default function MDWorkspace({ sessionId, showNewForm, onSessionCreated, onNewSession }: Props) {
  const [cfg, setCfg] = useState<Record<string, unknown>>({});
  const cfgRef = useRef<Record<string, unknown>>({});
  const [sessionLoading, setSessionLoading] = useState(!!sessionId);
  const [activeTab, setActiveTab] = useState("progress");
  const [selectedMolecule, setSelectedMolecule] = useState<{ content: string; name: string } | null>(null);
  const [moleculeLoading, setMoleculeLoading] = useState(false);
  const [simState, setSimState] = useState<SimState>("standby");
  const [simRunStatus, setSimRunStatus] = useState<"standby" | "running" | "finished" | "failed" | "paused">("standby");
  const [simExitCode, setSimExitCode] = useState<number | null>(null);
  const [simStartedAt, setSimStartedAt] = useState<number | null>(null);
  const [simFinishedAt, setSimFinishedAt] = useState<number | null>(null);
  const [pauseConfirmOpen, setPauseConfirmOpen] = useState(false);
  const [hasCheckpoint, setHasCheckpoint] = useState(true);
  const [showRunConfirm, setShowRunConfirm] = useState(false);
  const [resultCards, setResultCards] = useState<ResultCardDef[]>([]);
  const [gromacsSaveState, setGromacsSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const { setSession, sessions, addSession, setSessionMolecule, setSessionRunStatus, setSessionResultCards, appendSSEEvent, clearMessages } = useSessionStore();
  // Stable ref — lets the restore effect read latest sessions without re-running
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Reset simulation state when switching sessions, preserving terminal states from the store
  useEffect(() => {
    const stored = sessionsRef.current.find((s) => s.session_id === sessionId);
    const preserved = stored?.run_status === "finished" || stored?.run_status === "failed" || stored?.run_status === "paused" ? stored.run_status : "standby";
    // Sync the ref immediately so the polling effect's first pollStatus() call sees the
    // correct status for the new session, before setSimRunStatus triggers a re-render.
    // Without this, a switch from a "running" session causes the next session to falsely
    // map as "finished" (simRunStatusRef still "running" + backend returns not-running).
    simRunStatusRef.current = preserved;
    if (sessionId) setSessionLoading(true);
    setSimState("standby");
    setSimRunStatus(preserved);
    setSimExitCode(null);
    setSimStartedAt(stored?.started_at ? stored.started_at * 1000 : null);
    setSimFinishedAt(stored?.finished_at ? stored.finished_at * 1000 : null);
    setPauseConfirmOpen(false);
    setHasCheckpoint(true); // reset, will be checked below if paused
    setGromacsSaveState("idle");
    // Restore result cards from persisted session data, or use defaults
    const restoredCards = (stored?.result_cards ?? [])
      .map((entry: unknown) => {
        if (typeof entry === "string") {
          if (!VALID_RESULT_CARD_TYPES.has(entry)) return null;
          return { id: uuid(), type: entry as ResultCardType };
        }
        if (typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).type === "custom_cv" && (entry as Record<string, unknown>).meta) {
          const obj = entry as Record<string, unknown>;
          return { id: (obj.id as string) ?? uuid(), type: "custom_cv" as ResultCardType, meta: obj.meta as CustomCVConfig };
        }
        return null;
      })
      .filter(Boolean) as ResultCardDef[];
    setResultCards(restoredCards);
    // Clear chat messages so previous session's conversation doesn't bleed into the new session
    clearMessages();
    // Fetch authoritative wall-clock timestamps from session.json on disk.
    // The Zustand store may not have them yet (e.g. after page refresh or session switch).
    if (sessionId) {
      getSessionRunStatus(sessionId).then((rs) => {
        if (rs.started_at) setSimStartedAt((prev) => prev ?? rs.started_at! * 1000);
        if (rs.finished_at) setSimFinishedAt((prev) => prev ?? rs.finished_at! * 1000);
        if (rs.run_status === "running" || rs.run_status === "finished" || rs.run_status === "failed" || rs.run_status === "paused") {
          setSimRunStatus((prev) => prev === "standby" ? rs.run_status as typeof prev : prev);
        }
        // Check checkpoint availability when session is paused
        if (rs.run_status === "paused" || preserved === "paused") {
          checkCheckpoint(sessionId).then((r) => setHasCheckpoint(r.has_checkpoint)).catch(() => {});
        }
      }).catch(() => {});
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fix wall-clock race: sessions list may load after the above effect runs (page refresh).
  // When it arrives, fill in any missing timestamps without clobbering active state.
  useEffect(() => {
    if (!sessionId) return;
    const stored = sessions.find((s) => s.session_id === sessionId);
    if (!stored) return;
    if (stored.started_at) setSimStartedAt((prev) => prev ?? stored.started_at! * 1000);
    if (stored.finished_at) setSimFinishedAt((prev) => prev ?? stored.finished_at! * 1000);
    if (stored.run_status === "finished" || stored.run_status === "failed" || stored.run_status === "paused") {
      setSimRunStatus((prev) => (prev === "standby" ? stored.run_status! : prev));
    }
  }, [sessionId, sessions]); // eslint-disable-line react-hooks/exhaustive-deps

  const gromacsSaveSeqRef = useRef(0);
  const gromacsSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const simRunStatusRef = useRef(simRunStatus);
  simRunStatusRef.current = simRunStatus;

  // Keep the session list sidebar in sync with the current run status.
  // Use simRunStatusRef.current (not the closure value) so that when sessionId changes,
  // we write the already-reset preserved value rather than the stale previous-session status.
  useEffect(() => {
    if (sessionId) setSessionRunStatus(sessionId, simRunStatusRef.current);
  }, [sessionId, simRunStatus, setSessionRunStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist result cards to session.json whenever they change
  useEffect(() => {
    if (!sessionId) return;
    const serialized = resultCards.map((c) =>
      c.type === "custom_cv" && c.meta ? { type: c.type, id: c.id, meta: c.meta } : c.type
    );
    setSessionResultCards(sessionId, serialized);
    updateResultCards(sessionId, serialized).catch(() => {});
  }, [sessionId, resultCards, setSessionResultCards]);

  useEffect(() => {
    return () => {
      if (gromacsSavedTimerRef.current) clearTimeout(gromacsSavedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    // Don't reset selectedMolecule immediately — wait for the config to determine the
    // correct molecule file. This prevents a flash where the viewer unmounts (cancelling
    // any in-progress NGL load) only to remount moments later with the same file.
    let cancelled = false;
    cfgRef.current = {};
    setCfg({});
    setSessionLoading(true);
    setMoleculeLoading(true);

    getSessionConfig(sessionId)
      .then((r) => {
        if (cancelled) return;
        setCfg(r.config);
        cfgRef.current = r.config;
        setSessionLoading(false);

        // Derive work_dir and molecule file from the config (authoritative)
        const run = (r.config.run ?? {}) as Record<string, unknown>;
        const sys = (r.config.system ?? {}) as Record<string, unknown>;
        const workDir = (run.work_dir as string) ?? "";
        // Prefer session.json's selected_molecule; fall back to system.coordinates
        const session = sessionsRef.current.find((s) => s.session_id === sessionId);
        const molFile = session?.selected_molecule || (sys.coordinates as string) || "";

        if (molFile && workDir) {
          getFileContent(sessionId, `${workDir}/${molFile}`)
            .then((content) => {
              if (!cancelled) setSelectedMolecule({ content, name: molFile.split("/").pop() ?? molFile });
            })
            .catch(() => { if (!cancelled) setSelectedMolecule(null); })
            .finally(() => { if (!cancelled) setMoleculeLoading(false); });
        } else {
          setSelectedMolecule(null);
          setMoleculeLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedMolecule(null);
          setMoleculeLoading(false);
          setSessionLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  // Keep action button state in sync with the real mdrun process lifecycle.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const pollStatus = async () => {
      if (simRunStatusRef.current === "finished" || simRunStatusRef.current === "failed" || simRunStatusRef.current === "paused") return;
      try {
        const status = await getSimulationStatus(sessionId);
        if (cancelled) return;
        // Re-check after async gap — reset effect may have updated status to "failed" or "paused"
        if ((simRunStatusRef.current as string) === "failed" || (simRunStatusRef.current as string) === "paused") return;
        const mappedStatus: "standby" | "running" | "finished" | "failed" | "paused" =
          status.status === "finished" ? "finished"
            : status.status === "failed" ? "failed"
            : status.running ? "running"
            : simRunStatusRef.current === "running" ? "finished"
            : "standby";
        setSimRunStatus(mappedStatus);
        if (mappedStatus === "failed") setSimExitCode(status.exit_code ?? null);
        if (mappedStatus === "finished") { setSimExitCode(status.exit_code ?? 0); setSimFinishedAt((prev) => prev ?? (status.finished_at ? status.finished_at * 1000 : Date.now())); }
        if (mappedStatus === "running") setSimStartedAt((prev) => prev ?? (status.started_at ? status.started_at * 1000 : Date.now()));
        setSimState(status.running ? "running" : "standby");
        if (!status.running) setPauseConfirmOpen(false);
      } catch {
        // ignore transient polling errors
      }
    };

    void pollStatus();
    if (simRunStatus === "running") {
      timer = setInterval(() => { void pollStatus(); }, 2000);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [sessionId, simRunStatus]);

  const handleChange = (dotKey: string, value: unknown) => {
    const [section, ...rest] = dotKey.split(".");
    const setDeep = (
      obj: Record<string, unknown>,
      parts: string[],
      nextValue: unknown
    ): Record<string, unknown> => {
      const [head, ...tail] = parts;
      if (!head) return obj;
      return tail.length === 0
        ? { ...obj, [head]: nextValue }
        : { ...obj, [head]: setDeep((obj[head] as Record<string, unknown>) ?? {}, tail, nextValue) };
    };

    const current = cfgRef.current;
    const next = { ...current, [section]: setDeep((current[section] as Record<string, unknown>) ?? {}, rest, value) };
    // Keep cfgRef in sync immediately so saves triggered in the same event tick
    // (e.g., select/toggle changes) do not persist stale config.
    cfgRef.current = next;
    setCfg(next);
  };

  const handleSave = useCallback(async () => {
    if (!sessionId) return;
    await updateSessionConfig(sessionId, cfgRef.current).catch(() => {});
    await generateSessionFiles(sessionId).catch(() => {});
  }, [sessionId]);

  const handleGromacsSave = useCallback(async () => {
    if (!sessionId) return;
    const seq = ++gromacsSaveSeqRef.current;
    if (gromacsSavedTimerRef.current) {
      clearTimeout(gromacsSavedTimerRef.current);
      gromacsSavedTimerRef.current = null;
    }
    setGromacsSaveState("saving");
    await handleSave();
    if (seq !== gromacsSaveSeqRef.current) return;
    setGromacsSaveState("saved");
    gromacsSavedTimerRef.current = setTimeout(() => {
      setGromacsSaveState("idle");
    }, 1000);
  }, [handleSave, sessionId]);

  const handleStartMD = async () => {
    if (!sessionId || simRunStatus === "running" || simRunStatus === "finished") return;
    setSimState("running");
    setSimRunStatus("running");
    setSimExitCode(null);
    setSimStartedAt(null);
    setSimFinishedAt(null);
    try {
      const result = await startSimulation(sessionId);
      appendSSEEvent({ type: "text_delta", text: `Simulation started (PID ${result.pid}). Output files: ${Object.values(result.expected_files).join(", ")}` });
      appendSSEEvent({ type: "agent_done", final_text: "" });
      setSimStartedAt(Date.now());
    } catch (err) {
      console.error("Failed to start simulation:", err);
      appendSSEEvent({ type: "error", message: `Failed to start simulation: ${briefError(err)}` });
      setSimState("standby");
      setSimRunStatus("failed");
    }
  };

  const handleConfirmPause = async () => {
    setPauseConfirmOpen(false);
    if (!sessionId) return;
    // Set paused immediately so the poller doesn't race and map it to "finished"
    simRunStatusRef.current = "paused";
    setSimRunStatus("paused");
    setSimState("standby");
    try {
      const result = await stopSimulation(sessionId);
      setHasCheckpoint(result.has_checkpoint);
      if (!result.has_checkpoint) {
        appendSSEEvent({ type: "text_delta", text: "Warning: No checkpoint was saved. The simulation ran too briefly. You will need to restart instead of resuming.\n" });
      }
    } catch { /* ignore */ }
  };

  const handleResume = async () => {
    if (!sessionId) return;
    try {
      setSimState("running");
      setSimRunStatus("running");
      const result = await resumeSimulation(sessionId);
      if (result.status === "no_checkpoint" || !result.resumed) {
        // No checkpoint — backend already reset to standby
        appendSSEEvent({ type: "text_delta", text: (result.message ?? "No checkpoint found.") + "\n" });
        setSimState("standby");
        setSimRunStatus("standby");
        setHasCheckpoint(false);
        return;
      }
      appendSSEEvent({ type: "text_delta", text: "Simulation resumed from checkpoint.\n" });
    } catch (err) {
      console.error("Failed to resume simulation:", err);
      appendSSEEvent({ type: "error", message: `Failed to resume: ${briefError(err)}` });
      setSimState("standby");
      setSimRunStatus("standby");
      setHasCheckpoint(false);
    }
  };

  const handleTerminate = async () => {
    if (!sessionId) return;
    try {
      await terminateSimulation(sessionId);
    } catch { /* ignore */ }
    setSimState("standby");
    setSimRunStatus("standby");
    setSimStartedAt(null);
    setSimFinishedAt(null);
  };

  const handleSelectMolecule = async (m: { content: string; name: string }) => {
    setSelectedMolecule(m);
    if (!sessionId) return;
    // Update store immediately so switching sessions restores correctly
    setSessionMolecule(sessionId, m.name);
    // Persist to session.json
    await updateSessionMolecule(sessionId, m.name).catch(() => {});
    // Update system.coordinates in the Hydra config + regenerate YAML
    const updatedCfg = {
      ...cfg,
      system: { ...((cfg.system as Record<string, unknown>) ?? {}), coordinates: m.name },
    };
    setCfg(updatedCfg);
    cfgRef.current = updatedCfg;
    await updateSessionConfig(sessionId, updatedCfg).catch(() => {});
    await generateSessionFiles(sessionId).catch(() => {});
  };

  const handleSessionCreated = async (
    id: string,
    workDir: string,
    nickname: string,
    seededFiles: string[],
  ) => {
    const structExts = new Set(["pdb", "gro", "mol2", "xyz"]);
    const structFile = seededFiles.find((f) => structExts.has(f.split(".").pop()?.toLowerCase() ?? ""));

    // Add session to the sessions list with selected_molecule already set so the
    // sessionId-change useEffect can find it and skip the null fallback.
    addSession({
      session_id: id,
      work_dir: workDir,
      nickname,
      selected_molecule: structFile ?? "",
      run_status: "standby",
    });
    setSession(id, { method: "", system: "", gromacs: "", plumed_cvs: "", workDir });
    onSessionCreated(id, workDir, nickname);

    if (structFile) {
      setActiveTab("molecule");
      try {
        const content = await getFileContent(id, `${workDir}/${structFile}`);
        setSelectedMolecule({ content, name: structFile });
        setSessionMolecule(id, structFile);
        await updateSessionMolecule(id, structFile).catch(() => {});
      } catch { /* ignore */ }
    }
  };

  if (!sessionId) {
    if (showNewForm) {
      return (
        <div className="flex-1 flex flex-col bg-gray-50 dark:bg-gray-950 h-full">
          <NewSessionForm onCreated={handleSessionCreated} />
        </div>
      );
    }
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-gray-50 dark:bg-gray-950 h-full gap-6 px-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="w-16 h-16 rounded-2xl bg-gray-100 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 flex items-center justify-center">
            <FlaskConical size={28} className="text-gray-400 dark:text-gray-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">No session selected</p>
            <p className="text-xs text-gray-400 dark:text-gray-600 mt-1">Select a session from the sidebar or create a new one to get started.</p>
          </div>
        </div>
        <button
          onClick={onNewSession}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors shadow-lg shadow-blue-900/30"
        >
          <Plus size={14} />
          New Session
        </button>
      </div>
    );
  }

  // Only render the active tab — avoids mounting heavy components (3D viewers, Plotly) for inactive tabs
  const renderTab = () => {
    switch (activeTab) {
      case "progress":
        return (
          <ProgressTab
            sessionId={sessionId}
            runStatus={simRunStatus}
            exitCode={simExitCode}
            totalSteps={Number(((cfg.method as Record<string, unknown> | undefined)?.nsteps ?? 0))}
            timestepPs={Number(((cfg.gromacs as Record<string, unknown> | undefined)?.dt ?? 0.002))}
            runStartedAt={simStartedAt}
            runFinishedAt={simFinishedAt}
            resultCards={resultCards}
            setResultCards={setResultCards}
            systemName={(cfg.system as Record<string, unknown>)?.name as string ?? ""}
          />
        );
      case "molecule":
        return (
          <MoleculeTab
            sessionId={sessionId}
            cfg={cfg}
            selectedMolecule={selectedMolecule}
            moleculeLoading={moleculeLoading}
            onSelectMolecule={handleSelectMolecule}
            onMoleculeDeleted={(name) => {
              if (selectedMolecule?.name === name) setSelectedMolecule(null);
            }}
          />
        );
      case "gromacs":
        return <GromacsTab sessionId={sessionId} cfg={cfg} onChange={handleChange} onSave={handleGromacsSave} saveState={gromacsSaveState} runStatus={simRunStatus} />;
      case "method":
        return <MethodTab sessionId={sessionId} cfg={cfg} onChange={handleChange} onSave={handleSave} runStatus={simRunStatus} />;
      case "files":
        return <FilesTab sessionId={sessionId} />;
      default:
        return null;
    }
  };
  const actionState: "standby" | "running" | "finished" | "paused" =
    simRunStatus === "running" ? "running" :
    simRunStatus === "finished" ? "finished" :
    simRunStatus === "paused" ? "paused" :
    "standby";

  return (
    <div className="flex-1 flex flex-col bg-gray-50 dark:bg-gray-950 h-full min-w-0">
      <PillTabs active={activeTab} onChange={setActiveTab} saveState={gromacsSaveState} />

      <div className={`flex-1 overflow-y-auto [scrollbar-gutter:stable] ${sessionLoading ? "flex flex-col" : ""}`}>
        {sessionLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={24} className="animate-spin text-gray-400" />
              <span className="text-sm text-gray-500">Loading session…</span>
            </div>
          </div>
        ) : renderTab()}
      </div>

      {/* Simulation action button */}
      <div className="flex-shrink-0 px-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-900/50 h-[72px] flex items-center w-full">
        {actionState === "standby" && (
          <button
            onClick={() => setShowRunConfirm(true)}
            className="w-full flex items-center justify-center gap-2 py-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl transition-all shadow-lg shadow-blue-600/20 dark:shadow-blue-900/30 text-sm"
          >
            <Play size={16} fill="currentColor" />
            Start MD Simulation
          </button>
        )}
        {actionState === "finished" && (
          <button
            disabled
            className="w-full flex items-center justify-center gap-2 py-3 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-semibold rounded-xl text-sm cursor-not-allowed border border-emerald-200 dark:border-emerald-800/50"
          >
            <CheckCircle2 size={16} />
            Simulation Finished
          </button>
        )}
        {actionState === "running" && (
          <button
            onClick={() => setPauseConfirmOpen(true)}
            className="w-full flex items-center justify-center gap-2 py-3 bg-amber-500 hover:bg-amber-400 dark:bg-amber-600 dark:hover:bg-amber-500 text-white font-semibold rounded-xl transition-all shadow-lg shadow-amber-500/20 dark:shadow-amber-900/30 text-sm"
          >
            <Pause size={14} />
            Pause MD Simulation
          </button>
        )}
        {actionState === "paused" && (
          <div className="flex flex-col gap-2">
            {!hasCheckpoint && (
              <p className="text-xs text-amber-600 dark:text-amber-400 text-center">No checkpoint found — simulation ran too briefly. Restart required.</p>
            )}
            <div className="flex gap-2">
              {hasCheckpoint ? (
                <button
                  onClick={handleResume}
                  className="flex-1 flex items-center justify-center gap-2 py-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl transition-all shadow-lg shadow-blue-600/20 dark:shadow-blue-900/30 text-sm"
                >
                  <Play size={14} fill="currentColor" />
                  Resume
                </button>
              ) : (
                <button
                  onClick={() => { handleTerminate(); }}
                  className="flex-1 flex items-center justify-center gap-2 py-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl transition-all shadow-lg shadow-blue-600/20 dark:shadow-blue-900/30 text-sm"
                >
                  <RotateCcw size={14} />
                  Restart
                </button>
              )}
              <button
                onClick={handleTerminate}
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-red-600 hover:bg-red-500 text-white font-semibold rounded-xl transition-all shadow-lg shadow-red-600/20 dark:shadow-red-900/30 text-sm"
              >
                <Square size={14} fill="currentColor" />
                Stop
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Simulation run confirmation dialog */}
      {showRunConfirm && (
        <SimRunConfirmModal
          cfg={cfg}
          onEdit={() => { setShowRunConfirm(false); setActiveTab("gromacs"); }}
          onRun={() => { setShowRunConfirm(false); handleStartMD(); }}
          onClose={() => setShowRunConfirm(false)}
        />
      )}

      {/* Pause confirmation dialog */}
      {pauseConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 shadow-2xl max-w-sm w-full mx-4">
            <h3 className="text-sm font-semibold text-gray-100 mb-2">Pause Simulation?</h3>
            <p className="text-xs text-gray-400 mb-5 leading-relaxed">
              This will pause the running mdrun process. A checkpoint is saved automatically — you can resume from where it stopped.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setPauseConfirmOpen(false)}
                className="px-4 py-2 text-xs text-gray-400 hover:text-gray-200 transition-colors rounded-lg hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmPause}
                className="px-4 py-2 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors font-medium"
              >
                Pause Simulation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
