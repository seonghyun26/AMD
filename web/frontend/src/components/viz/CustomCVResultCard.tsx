"use client";

import { useEffect, useRef, useState } from "react";
import {
  Loader2,
  RotateCcw,
  Download,
  Search,
  Trash2,
  X,
  Settings,
} from "lucide-react";
import dynamic from "next/dynamic";
import { computeCustomCV, type CVDefinition, type CustomCVConfig } from "@/lib/api";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

// ── Constants ─────────────────────────────────────────────────────────

const COLORMAPS = [
  "Blues", "viridis", "Plasma", "Inferno", "Magma",
  "Cividis", "YlGnBu", "PuBu", "BuPu", "Hot",
] as const;

function cvShortLabel(cv: CVDefinition): string {
  const ids = cv.atoms.join(",");
  if (cv.type === "distance") return `d(${ids})`;
  if (cv.type === "angle") return `∠(${ids})`;
  return `τ(${ids})`;
}

function headerLabel(cvs: CVDefinition[]): string {
  return cvs.map(cvShortLabel).join(" × ");
}

function unitLabel(cv: CVDefinition): string {
  if (cv.type === "distance") return "Å";
  return "°";
}

// ── Plotly layout helpers ────────────────────────────────────────────

const DARK_AXIS = {
  gridcolor: "#1f2937",
  zerolinecolor: "#374151",
  tickfont: { size: 9 },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function darkLayout(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    font: { color: "#9ca3af", size: 10 },
    margin: { l: 48, r: 12, t: 8, b: 40 },
    xaxis: { ...DARK_AXIS },
    yaxis: { ...DARK_AXIS },
    ...overrides,
  };
}

// ── Settings panel (matches Ramachandran settings pattern) ──────────

interface DensitySettings {
  colorscale: string;
  nbins: number;
  logScale: boolean;
}

const DENSITY_DEFAULTS: DensitySettings = {
  colorscale: "viridis",
  nbins: 60,
  logScale: true,
};

const DENSITY_STORAGE_KEY = "amd-cv-density-settings";

function loadDensitySettings(): DensitySettings {
  if (typeof window === "undefined") return { ...DENSITY_DEFAULTS };
  try {
    const raw = localStorage.getItem(DENSITY_STORAGE_KEY);
    if (!raw) return { ...DENSITY_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<DensitySettings>;
    return { ...DENSITY_DEFAULTS, ...parsed };
  } catch {
    return { ...DENSITY_DEFAULTS };
  }
}

function saveDensitySettings(s: DensitySettings) {
  try { localStorage.setItem(DENSITY_STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

function SettingsDropdown({
  settings,
  onChange,
  onClose,
}: {
  settings: DensitySettings;
  onChange: <K extends keyof DensitySettings>(key: K, val: DensitySettings[K]) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl text-xs overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800/80 border-b border-gray-200 dark:border-gray-700">
        <span className="font-semibold text-gray-700 dark:text-gray-200">Plot Settings</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-200 transition-colors">
          <X size={12} />
        </button>
      </div>
      <div className="p-3 space-y-3">
        <div className="flex items-center gap-2">
          <span className="w-20 text-gray-500 dark:text-gray-400 flex-shrink-0">Bins</span>
          <input type="range" min={20} max={150} step={10} value={settings.nbins}
            onChange={(e) => onChange("nbins", Number(e.target.value))}
            className="flex-1 accent-cyan-500 h-1" />
          <span className="w-8 text-right text-gray-700 dark:text-gray-300 tabular-nums">{settings.nbins}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-20 text-gray-500 dark:text-gray-400 flex-shrink-0">Colormap</span>
          <select value={settings.colorscale} onChange={(e) => onChange("colorscale", e.target.value)}
            className="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 text-gray-700 dark:text-gray-200 text-xs focus:outline-none focus:border-cyan-600">
            {COLORMAPS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="border-t border-gray-200 dark:border-gray-800" />
        <div className="flex items-center justify-between">
          <span className="text-gray-500 dark:text-gray-400">Log scale</span>
          <button onClick={() => onChange("logScale", !settings.logScale)}
            className={`w-8 h-4 rounded-full transition-colors relative flex-shrink-0 ${settings.logScale ? "bg-cyan-600" : "bg-gray-300 dark:bg-gray-700"}`}>
            <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${settings.logScale ? "left-[18px]" : "left-0.5"}`} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Toolbar button (matches Ramachandran style) ─────────────────────

const BTN = "p-1 rounded text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 transition-colors";
const BTN_DISABLED = `${BTN} disabled:opacity-50 disabled:cursor-not-allowed`;

// ── Main component ───────────────────────────────────────────────────

interface Props {
  sessionId: string;
  config: CustomCVConfig;
  onDelete: () => void;
}

export default function CustomCVResultCard({ sessionId, config, onDelete }: Props) {
  const [data, setData] = useState<Record<string, number[] | string[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [spinning, setSpinning] = useState(false);

  // Settings (2-CV density / all modes) — persisted in localStorage
  const [densitySettings, setDensitySettings] = useState<DensitySettings>(loadDensitySettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  const numCVs = config.cvs.length;
  const accentColor = numCVs === 1 ? "#f59e0b" : numCVs === 2 ? "#06b6d4" : "#a78bfa";

  // Persist density settings to localStorage
  useEffect(() => { saveDensitySettings(densitySettings); }, [densitySettings]);

  // Close settings on outside click
  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [settingsOpen]);

  const fetchData = async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await computeCustomCV(sessionId, config, force);
      if (result.available) {
        setData(result.data);
      } else {
        setError((result as { error?: string }).error ?? "No data available");
      }
    } catch (e) {
      console.error("Custom CV computation failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.split("\n")[0].slice(0, 120));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = () => {
    setSpinning(true);
    setTimeout(() => setSpinning(false), 800);
    fetchData(true);
  };

  const handleDownload = () => {
    if (!data) return;
    const labels = data.cv_labels as string[];
    const timePsArr = data.time_ps as number[];
    if (!timePsArr || timePsArr.length === 0) return;

    // Build CSV
    const header = ["time_ps", ...labels].join(",");
    const rows = timePsArr.map((t, i) => {
      const vals = labels.map((l) => {
        const arr = data[l] as number[];
        return arr?.[i] ?? "";
      });
      return [t, ...vals].join(",");
    });
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `custom_cv_${labels.join("_")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Build Plotly traces & layout ──────────────────────────────────

  const buildPlot = (compact: boolean) => {
    if (!data) return null;
    const labels = data.cv_labels as string[];
    const timePsRaw = data.time_ps as number[];

    if (numCVs === 1) {
      const cv = config.cvs[0];
      const yVals = data[labels[0]] as number[];
      if (!yVals) return null;
      return {
        traces: [{
          type: "scatter" as const,
          mode: "lines" as const,
          x: timePsRaw,
          y: yVals,
          fill: "tozeroy" as const,
          fillcolor: "rgba(245,158,11,0.10)",
          line: { color: "#f59e0b", width: compact ? 1.5 : 2, shape: "spline" as const },
          hovertemplate: `%{x:.1f} ps<br>%{y:.3f} ${unitLabel(cv)}<extra></extra>`,
        }],
        layout: darkLayout({
          xaxis: { ...DARK_AXIS, title: { text: "Time (ps)", font: { size: 9, color: "#6b7280" } } },
          yaxis: { ...DARK_AXIS, title: { text: `${cv.label} (${unitLabel(cv)})`, font: { size: 9, color: "#6b7280" } } },
        }),
      };
    }

    if (numCVs === 2) {
      const cv1 = config.cvs[0];
      const cv2 = config.cvs[1];
      const xVals = data[labels[0]] as number[];
      const yVals = data[labels[1]] as number[];
      if (!xVals || !yVals) return null;
      return {
        traces: [{
          type: "histogram2dcontour" as const,
          x: xVals,
          y: yVals,
          colorscale: densitySettings.colorscale,
          colorbar: { thickness: 8, len: 0.6 },
          contours: { coloring: "heatmap" as const },
          line: { width: 0 },
          nbinsx: densitySettings.nbins,
          nbinsy: densitySettings.nbins,
          zauto: !densitySettings.logScale,
          hovertemplate: `${cv1.label}: %{x:.2f}<br>${cv2.label}: %{y:.2f}<br>Count: %{z}<extra></extra>`,
        }],
        layout: darkLayout({
          margin: compact ? { l: 40, r: 8, t: 8, b: 36 } : { l: 52, r: 12, t: 8, b: 44 },
          xaxis: { ...DARK_AXIS, title: { text: `${cv1.label} (${unitLabel(cv1)})`, font: { size: 9, color: "#6b7280" } } },
          yaxis: { ...DARK_AXIS, title: { text: `${cv2.label} (${unitLabel(cv2)})`, font: { size: 9, color: "#6b7280" } } },
        }),
      };
    }

    if (numCVs === 3) {
      const cv1 = config.cvs[0];
      const cv2 = config.cvs[1];
      const cv3 = config.cvs[2];
      const xVals = data[labels[0]] as number[];
      const yVals = data[labels[1]] as number[];
      const zVals = data[labels[2]] as number[];
      if (!xVals || !yVals || !zVals) return null;
      return {
        traces: [{
          type: "scatter3d" as const,
          mode: "markers" as const,
          x: xVals,
          y: yVals,
          z: zVals,
          marker: {
            size: compact ? 1.5 : 2.5,
            color: timePsRaw,
            colorscale: "viridis",
            colorbar: compact ? undefined : { title: { text: "Time (ps)", font: { size: 9 } }, thickness: 8, len: 0.5 },
            opacity: 0.7,
          },
          hovertemplate: `${cv1.label}: %{x:.2f}<br>${cv2.label}: %{y:.2f}<br>${cv3.label}: %{z:.2f}<extra></extra>`,
        }],
        layout: darkLayout({
          margin: compact ? { l: 0, r: 0, t: 0, b: 0 } : { l: 0, r: 0, t: 0, b: 0 },
          scene: {
            xaxis: { title: { text: cv1.label, font: { size: 9 } }, gridcolor: "#1f2937", backgroundcolor: "transparent", tickfont: { size: 8 } },
            yaxis: { title: { text: cv2.label, font: { size: 9 } }, gridcolor: "#1f2937", backgroundcolor: "transparent", tickfont: { size: 8 } },
            zaxis: { title: { text: cv3.label, font: { size: 9 } }, gridcolor: "#1f2937", backgroundcolor: "transparent", tickfont: { size: 8 } },
            bgcolor: "transparent",
            camera: { eye: { x: 1.5, y: 1.5, z: 1.2 } },
          },
        }),
      };
    }

    return null;
  };

  // ── Sizing ────────────────────────────────────────────────────────

  const cardWidth = numCVs === 2 ? "300px" : "440px";
  const expandedWidth = numCVs === 3 ? "min(900px, 95vw)" : numCVs === 2 ? "min(600px, 95vw)" : "min(1080px, 95vw)";
  const expandedHeight = numCVs === 3 ? "min(640px, 90vh)" : numCVs === 2 ? "min(600px, 90vh)" : "420px";
  const hasData = !loading && !error && data;

  // ── Render plot helper ────────────────────────────────────────────

  const renderPlot = (compact: boolean) => {
    if (loading) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-500">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-xs">Computing CVs…</span>
        </div>
      );
    }
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-2 px-3 text-center">
          <span className="text-xs text-red-400">{error}</span>
          <button onClick={handleRefresh} className="text-xs text-blue-400 hover:underline">Retry</button>
        </div>
      );
    }
    const plotData = buildPlot(compact);
    if (!plotData) {
      return <div className="flex items-center justify-center h-full text-xs text-gray-400 dark:text-gray-600">No data</div>;
    }
    return (
      <Plot
        data={plotData.traces as Plotly.Data[]}
        layout={{ ...(plotData.layout as unknown as Plotly.Layout), autosize: true }}
        config={{ displayModeBar: !compact, responsive: true, scrollZoom: !compact }}
        useResizeHandler
        style={{ width: "100%", height: "100%" }}
      />
    );
  };

  // ── Settings gear (shown in both card and expanded for 2-CV) ──────

  const renderSettingsGear = (size: number) => {
    if (numCVs !== 2) return null;
    return (
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
          <Settings size={size} />
        </button>
        {settingsOpen && (
          <SettingsDropdown
            settings={densitySettings}
            onChange={(key, val) => setDensitySettings((prev) => ({ ...prev, [key]: val }))}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>
    );
  };

  // ── Card ──────────────────────────────────────────────────────────

  return (
    <>
      <div
        className="flex-shrink-0 rounded-xl border bg-gray-50/70 dark:bg-gray-900/70 flex flex-col overflow-hidden"
        style={{ width: cardWidth, height: "300px", borderColor: `${accentColor}30` }}
      >
        {/* Header — matches Ramachandran card exactly */}
        <div
          className="flex items-center justify-between px-3 py-2 border-b flex-shrink-0"
          style={{ borderColor: `${accentColor}20` }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: accentColor }} />
            <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{headerLabel(config.cvs)}</span>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={handleRefresh} title="Refresh" className={BTN}>
              <RotateCcw size={13} className={spinning ? "animate-spin" : ""} />
            </button>
            <button onClick={handleDownload} disabled={!hasData} title="Download CSV" className={BTN_DISABLED}>
              <Download size={13} />
            </button>
            <button onClick={() => setExpanded(true)} title="Expand" className={BTN}>
              <Search size={13} />
            </button>
            {renderSettingsGear(13)}
            <button onClick={() => setConfirmDelete(true)} title="Remove" className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 transition-colors">
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        {/* Chart area */}
        <div className="flex-1 min-h-0 overflow-hidden relative">
          {renderPlot(true)}
        </div>
      </div>

      {/* ── Expanded modal ──────────────────────────────────────────── */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setExpanded(false)}
        >
          <div
            className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl flex flex-col overflow-hidden border"
            style={{ width: expandedWidth, height: expandedHeight, borderColor: `${accentColor}40` }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Expanded header — matches Ramachandran expanded modal */}
            <div
              className="flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-800/80 border-b flex-shrink-0"
              style={{ borderColor: `${accentColor}25` }}
            >
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: accentColor }} />
                <span className="text-sm font-semibold tracking-wide" style={{ color: accentColor }}>
                  {headerLabel(config.cvs)}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={handleRefresh} title="Refresh"
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                  <RotateCcw size={13} className={spinning ? "animate-spin" : ""} />
                </button>
                <button onClick={handleDownload} disabled={!hasData} title="Download CSV"
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  <Download size={13} />
                </button>
                {/* Settings gear (2-CV mode) */}
                {numCVs === 2 && (
                  <div className="relative" ref={settingsRef}>
                    <button
                      onClick={() => setSettingsOpen((v) => !v)}
                      title="Plot settings"
                      className={`p-1.5 rounded-lg transition-colors ${
                        settingsOpen ? "text-cyan-600 bg-cyan-100/60 dark:text-cyan-400 dark:bg-cyan-900/30" : "text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                      }`}
                    >
                      <Settings size={13} />
                    </button>
                    {settingsOpen && (
                      <SettingsDropdown
                        settings={densitySettings}
                        onChange={(key, val) => setDensitySettings((prev) => ({ ...prev, [key]: val }))}
                        onClose={() => setSettingsOpen(false)}
                      />
                    )}
                  </div>
                )}
                <button onClick={() => setExpanded(false)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                  <X size={14} />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {renderPlot(false)}
            </div>
          </div>
        </div>
      )}

      {/* ── Delete confirmation ──────────────────────────────────────── */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setConfirmDelete(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-2xl p-5 w-72" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">Remove plot?</p>
            <p className="text-xs text-gray-500 mb-4">
              The <span className="text-gray-700 dark:text-gray-300">{headerLabel(config.cvs)}</span> plot will be removed.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 rounded-lg text-xs border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                Cancel
              </button>
              <button onClick={() => { setConfirmDelete(false); onDelete(); }}
                className="px-3 py-1.5 rounded-lg text-xs border border-red-200 dark:border-red-800/60 bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors">
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
