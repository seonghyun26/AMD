"use client";

import { useEffect, useRef, useState } from "react";
import { X, Loader2, AlertCircle, Crosshair, Camera, Settings } from "lucide-react";
import { suppressNglDeprecationWarnings } from "@/lib/ngl";
import { useTheme } from "@/lib/theme";

function parseStructureInfo(
  content: string,
  fileName: string,
): { atoms: number; residues: number } | null {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "gro") {
    const lines = content.split("\n");
    const atoms = parseInt(lines[1]?.trim() ?? "", 10);
    if (isNaN(atoms)) return null;
    const seen = new Set<string>();
    for (let i = 2; i < 2 + atoms && i < lines.length; i++) {
      const l = lines[i];
      if (l.length < 10) continue;
      seen.add(l.substring(0, 5).trim() + ":" + l.substring(5, 10).trim());
    }
    return { atoms, residues: seen.size };
  }
  if (ext === "pdb") {
    let atoms = 0;
    const seen = new Set<string>();
    for (const l of content.split("\n")) {
      if (l.startsWith("ATOM  ") || l.startsWith("HETATM")) {
        atoms++;
        seen.add(l.substring(21, 22) + l.substring(22, 26).trim());
      }
    }
    return atoms > 0 ? { atoms, residues: seen.size } : null;
  }
  return null;
}

interface Props {
  fileContent: string;
  fileName: string;
  onClose?: () => void;
  inline?: boolean;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    NGL: any;
  }
}

interface RepState {
  ball: boolean;
  stick: boolean;
  ribbon: boolean;
  surface: boolean;
}

const REP_LABELS: { key: keyof RepState; label: string }[] = [
  { key: "ball",    label: "Ball"    },
  { key: "stick",   label: "Stick"   },
  { key: "ribbon",  label: "Cartoon" },
  { key: "surface", label: "Surface" },
];


// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyRepresentations(component: any, reps: RepState) {
  component.removeAllRepresentations();
  if (reps.ball) {
    component.addRepresentation("spacefill", { colorScheme: "element", radiusScale: 0.2 });
  }
  if (reps.stick) {
    component.addRepresentation("licorice", { colorScheme: "element" });
  }
  if (reps.ribbon) {
    component.addRepresentation("cartoon", { sele: "protein", colorScheme: "residueindex" });
  }
  if (reps.surface) {
    component.addRepresentation("surface", { color: "white", opacity: 0.1 });
  }
}

const DEFAULT_REPS: RepState = {
  ball: true,
  stick: true,
  ribbon: false,
  surface: false,
};

/** Capture a screenshot from the NGL stage. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function captureImage(stage: any, opts: { factor: number; antialias: boolean; trim: boolean }): Promise<Blob> {
  return await stage.makeImage({ ...opts, transparent: true });
}

export default function MoleculeViewer({ fileContent, fileName, onClose, inline = false }: Props) {
  const containerRef     = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stageRef         = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const componentRef     = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initialOrientRef = useRef<any>(null);
  const repsRef          = useRef<RepState>(DEFAULT_REPS);

  const [ready, setReady]           = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [reps, setReps]             = useState<RepState>(DEFAULT_REPS);
  const [structInfo, setStructInfo] = useState<{ atoms: number; residues: number } | null>(null);
  const { theme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef                    = useRef<HTMLDivElement>(null);

  const [exportSettings, setExportSettings] = useState({
    factor: 6, antialias: true, trim: false,
  });

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

  // Keep repsRef in sync so the load effect never reads stale state
  useEffect(() => { repsRef.current = reps; }, [reps]);

  // Re-apply representations when toggles change
  useEffect(() => {
    if (!componentRef.current) return;
    applyRepresentations(componentRef.current, reps);
    try { stageRef.current?.viewer?.requestRender?.(); } catch { /* ignore */ }
  }, [reps]);

  // Load / reload structure when file content or name changes
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(null);
    setStructInfo(null);
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "pdb";
    let ro: ResizeObserver | null = null;

    const initViewer = () => {
      if (cancelled || !containerRef.current || !window.NGL) return;

      if (stageRef.current) {
        stageRef.current.dispose();
        stageRef.current = null;
      }
      componentRef.current = null;
      initialOrientRef.current = null;
      containerRef.current.innerHTML = "";

      suppressNglDeprecationWarnings();
      const stage = new window.NGL.Stage(containerRef.current, { backgroundColor: theme === "dark" ? "#111827" : "#ffffff" });
      stageRef.current = stage;

      ro = new ResizeObserver(() => stage.handleResize());
      ro.observe(containerRef.current);

      setStructInfo(parseStructureInfo(fileContent, fileName));

      const blob = new Blob([fileContent], { type: "text/plain" });
      stage
        .loadFile(blob, { ext, defaultRepresentation: false, name: fileName })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((component: any) => {
          if (cancelled) return;
          componentRef.current = component;
          try { applyRepresentations(component, repsRef.current); } catch { /* ignore */ }
          try {
            component.autoView(600);
            // Capture orientation after the autoView animation completes
            setTimeout(() => {
              try { initialOrientRef.current = stage.viewerControls.getOrientation(); } catch { /* ignore */ }
            }, 650);
          } catch { /* ignore */ }
          setReady(true);
        })
        .catch((err: unknown) => {
          if (!cancelled) { console.error("MoleculeViewer load failed:", err); setError(err instanceof Error ? err.message.split("\n")[0] : "Failed to load structure"); }
        });
    };

    let scriptEl: HTMLScriptElement | null = null;
    let loadHandler: (() => void) | null = null;
    if (window.NGL) {
      initViewer();
    } else {
      const existing = document.getElementById("ngl-script") as HTMLScriptElement | null;
      if (existing) {
        scriptEl = existing;
        if (window.NGL || existing.dataset.loaded === "true") {
          initViewer();
        } else {
          loadHandler = () => {
            existing.dataset.loaded = "true";
            initViewer();
          };
          existing.addEventListener("load", loadHandler, { once: true });
        }
      } else {
        const script = document.createElement("script");
        scriptEl = script;
        script.id = "ngl-script";
        script.src = "https://cdn.jsdelivr.net/npm/ngl/dist/ngl.js";
        script.async = true;
        loadHandler = () => {
          script.dataset.loaded = "true";
          initViewer();
        };
        script.addEventListener("load", loadHandler, { once: true });
        document.head.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
      if (scriptEl && loadHandler) {
        scriptEl.removeEventListener("load", loadHandler);
      }
      ro?.disconnect();
      if (stageRef.current) {
        stageRef.current.dispose();
        stageRef.current = null;
      }
      componentRef.current = null;
      initialOrientRef.current = null;
    };
  }, [fileContent, fileName]);

  // Update NGL background when theme changes
  useEffect(() => {
    stageRef.current?.setParameters({ backgroundColor: theme === "dark" ? "#111827" : "#ffffff" });
  }, [theme]);

  const handleResetView = () => {
    if (!stageRef.current) return;
    if (initialOrientRef.current) {
      stageRef.current.animationControls.orient(initialOrientRef.current, 800);
    } else {
      componentRef.current?.autoView(800);
    }
  };

  const handleScreenshot = async () => {
    if (!stageRef.current) return;
    const blob = await captureImage(stageRef.current, exportSettings);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName.replace(/\.[^.]+$/, "")}_view.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleRepToggle = (key: keyof RepState) => {
    setReps((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  if (inline) {
    return (
      <div className="space-y-2">
        {/* Viewer canvas */}
        <div
          className="relative rounded-xl border border-gray-300/60 dark:border-gray-700/60 bg-white dark:bg-gray-900 overflow-hidden"
          style={{ height: "360px" }}
        >
          {error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-red-500 gap-2 p-4 z-10">
              <AlertCircle size={20} />
              <span className="text-xs text-center break-all">{error}</span>
            </div>
          ) : !ready ? (
            <div className="absolute inset-0 flex items-center justify-center text-gray-400 z-10">
              <Loader2 size={20} className="animate-spin mr-2" />
              <span className="text-xs">Loading…</span>
            </div>
          ) : null}
          <div ref={containerRef} className="w-full h-full" />
          {structInfo && (
            <div className="absolute top-2 left-2 flex gap-1.5 pointer-events-none">
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-white/80 dark:bg-gray-900/75 text-gray-600 dark:text-gray-300">
                {structInfo.atoms.toLocaleString()} atoms
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-white/80 dark:bg-gray-900/75 text-gray-600 dark:text-gray-300">
                {structInfo.residues} residues
              </span>
            </div>
          )}
          {ready && (
            <div className="absolute bottom-0 left-0 right-0 px-3 py-1 bg-white/80 dark:bg-gray-900/80 text-[10px] text-gray-600 dark:text-gray-500">
              drag to rotate · scroll to zoom · right-click to translate
            </div>
          )}
        </div>

        {/* Controls row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            {REP_LABELS.map(({ key, label }) => {
              const on = reps[key];
              return (
                <button
                  key={key}
                  onClick={() => handleRepToggle(key)}
                  disabled={!ready}
                  className={`px-2 py-1 rounded text-[10px] border transition-colors disabled:opacity-40 ${
                    on
                      ? "bg-indigo-600 border-indigo-500 text-white"
                      : "bg-gray-100/60 dark:bg-gray-800/60 border-gray-300/50 dark:border-gray-700/50 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleResetView}
              disabled={!ready}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border border-gray-300/60 dark:border-gray-700/60 bg-gray-100/60 dark:bg-gray-800/60 text-gray-600 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 disabled:opacity-40"
            >
              <Crosshair size={11} />
              Reset
            </button>
            <button
              onClick={handleScreenshot}
              disabled={!ready}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border border-gray-300/60 dark:border-gray-700/60 bg-gray-100/60 dark:bg-gray-800/60 text-gray-600 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 disabled:opacity-40"
            >
              <Camera size={11} />
              Screenshot
            </button>

            {/* Settings */}
            <div className="relative" ref={settingsRef}>
              <button
                onClick={() => setSettingsOpen((v) => !v)}
                title="Export settings"
                className={`flex items-center justify-center w-[30px] h-[26px] rounded-md text-xs border transition-colors ${
                  settingsOpen
                    ? "border-indigo-500 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-300"
                    : "border-gray-300/60 dark:border-gray-700/60 bg-gray-100/60 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200/60 dark:hover:bg-gray-700/60"
                }`}
              >
                <Settings size={11} />
              </button>

              {settingsOpen && (
                <div className="absolute right-0 bottom-full mb-2 z-50 w-64 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl text-xs overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800/80 border-b border-gray-200 dark:border-gray-700">
                    <span className="font-semibold text-gray-700 dark:text-gray-200">Export Settings</span>
                    <button onClick={() => setSettingsOpen(false)} className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-200 transition-colors">
                      <X size={12} />
                    </button>
                  </div>
                  <div className="p-3 space-y-2">
                    {/* Factor */}
                    <div className="flex items-center gap-2">
                      <span className="w-20 text-gray-500 dark:text-gray-400 flex-shrink-0">Factor</span>
                      <input
                        type="range" min={1} max={8} step={1}
                        value={exportSettings.factor}
                        onChange={(e) => setExportSettings((s) => ({ ...s, factor: Number(e.target.value) }))}
                        className="flex-1 accent-indigo-500 h-1"
                      />
                      <span className="w-8 text-right text-gray-700 dark:text-gray-300 tabular-nums">{exportSettings.factor}×</span>
                    </div>
                    {/* Booleans */}
                    {(["antialias", "trim"] as const).map((key) => (
                      <div key={key} className="flex items-center justify-between">
                        <span className="text-gray-500 dark:text-gray-400 capitalize">{key}</span>
                        <button
                          onClick={() => setExportSettings((s) => ({ ...s, [key]: !s[key] }))}
                          className={`w-8 h-4 rounded-full transition-colors relative flex-shrink-0 ${exportSettings[key] ? "bg-indigo-600" : "bg-gray-300 dark:bg-gray-700"}`}
                        >
                          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${exportSettings[key] ? "left-[18px]" : "left-0.5"}`} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Popup / modal variant ──────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl overflow-hidden flex flex-col shadow-2xl border border-gray-200 dark:border-gray-700"
        style={{ width: "75vw", height: "75vh" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-sm font-mono text-gray-800 dark:text-gray-200">{fileName}</span>
            <span className="text-xs text-gray-400 dark:text-gray-500">3D Viewer</span>
            {/* Toggle buttons in popup header */}
            <div className="flex gap-1 ml-2">
              {REP_LABELS.map(({ key, label }) => {
                const on = reps[key];
                return (
                  <button
                    key={key}
                    onClick={() => handleRepToggle(key)}
                    disabled={!ready}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors border disabled:opacity-40 ${
                      on
                        ? "bg-indigo-600 border-indigo-500 text-white"
                        : "bg-gray-200 dark:bg-gray-700/50 border-gray-300 dark:border-gray-600/50 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Viewer */}
        <div className="relative flex-1">
          {error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-red-500 gap-2 z-10">
              <AlertCircle size={24} />
              <span className="text-sm">{error}</span>
            </div>
          ) : !ready ? (
            <div className="absolute inset-0 flex items-center justify-center text-gray-400 z-10">
              <Loader2 size={24} className="animate-spin mr-2" />
              <span className="text-sm">Loading viewer…</span>
            </div>
          ) : null}
          <div ref={containerRef} className="w-full h-full" />
        </div>

        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-400 dark:text-gray-500 flex-shrink-0">
          Drag to rotate · Scroll to zoom · Right-click to translate
        </div>
      </div>
    </div>
  );
}
