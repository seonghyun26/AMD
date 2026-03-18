"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, Trash2, MousePointer2, ChevronDown, Zap, X } from "lucide-react";
import { suppressNglDeprecationWarnings } from "@/lib/ngl";
import { getFileContent, listFiles, getMacroCvs } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { CV_PALETTE } from "@/lib/colors";

export interface AtomInfo {
  index: number;   // 1-based
  name: string;
  resName: string;
  resSeq: number;
}

export interface CVSlot {
  type: "distance" | "angle" | "dihedral";
  atoms: (AtomInfo | null)[];
  label: string;
}

/** Config-level CV definition (PLUMED format stored in session config). */
export interface ConfigCV {
  name: string;
  type: string;          // DISTANCE | TORSION | ANGLE | ...
  atoms?: number[];
  [key: string]: unknown;
}

const REQUIRED_ATOMS: Record<CVSlot["type"], number> = { distance: 2, angle: 3, dihedral: 4 };
const CV_COLORS = CV_PALETTE;
const CV_TYPE_OPTIONS: { value: CVSlot["type"]; label: string }[] = [
  { value: "distance", label: "Distance" },
  { value: "angle",    label: "Angle" },
  { value: "dihedral", label: "Dihedral" },
];

/** Map PLUMED type → picker type */
const PLUMED_TO_PICKER: Record<string, CVSlot["type"]> = {
  DISTANCE: "distance", TORSION: "dihedral", ANGLE: "angle",
  distance: "distance", dihedral: "dihedral", angle: "angle", torsion: "dihedral",
};

/** Map picker type → PLUMED type */
const PICKER_TO_PLUMED: Record<string, string> = {
  distance: "DISTANCE", angle: "ANGLE", dihedral: "TORSION",
};

function makeEmptyCV(index: number, type: CVSlot["type"] = "distance"): CVSlot {
  return { type, atoms: Array(REQUIRED_ATOMS[type]).fill(null), label: `CV${index + 1}` };
}

function atomLabel(a: AtomInfo): string {
  // Only show residue info if it came from NGL picking (not typed index)
  if (a.resName === "?" || a.name.startsWith("#")) return `Atom ${a.index}`;
  return `${a.resName}${a.resSeq}:${a.name}`;
}

function shortCVLabel(cv: CVSlot): string {
  const filled = cv.atoms.filter(Boolean) as AtomInfo[];
  const ids = filled.map((a) => a.index).join(",");
  if (cv.type === "distance") return `d(${ids})`;
  if (cv.type === "angle") return `∠(${ids})`;
  return `τ(${ids})`;
}

/** Convert config CVs → internal CVSlots for the picker */
function configToSlots(configCvs: ConfigCV[]): CVSlot[] {
  if (!configCvs || configCvs.length === 0) return [makeEmptyCV(0)];
  return configCvs.map((cv, i) => {
    const pickerType = PLUMED_TO_PICKER[cv.type] ?? "distance";
    const needed = REQUIRED_ATOMS[pickerType];
    const atoms: (AtomInfo | null)[] = Array(needed).fill(null);
    if (cv.atoms) {
      for (let j = 0; j < Math.min(cv.atoms.length, needed); j++) {
        const idx = cv.atoms[j];
        if (idx > 0) atoms[j] = { index: idx, name: `#${idx}`, resName: "?", resSeq: 0 };
      }
    }
    return { type: pickerType, atoms, label: cv.name || `CV${i + 1}` };
  });
}

/** Convert internal CVSlots → config CVs */
function slotsToConfig(slots: CVSlot[]): ConfigCV[] {
  return slots.map((cv) => ({
    name: cv.label,
    type: PICKER_TO_PLUMED[cv.type] ?? cv.type.toUpperCase(),
    atoms: cv.atoms.map((a) => a?.index ?? 0),
  }));
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    NGL: any;
  }
}

interface Props {
  sessionId: string;
  /** Current CVs from config — the picker stays in sync with this */
  cvs: ConfigCV[];
  /** Called whenever CVs change (add, remove, pick atom, type atom) */
  onChange: (cvs: ConfigCV[]) => void;
}

export default function InlineCVPicker({ sessionId, cvs, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stageRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const componentRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const highlightRepsRef = useRef<any[]>([]);
  const roRef = useRef<ResizeObserver | null>(null);

  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoverInfo, setHoverInfo] = useState<string | null>(null);
  const { theme } = useTheme();

  const [cvSlots, setCvSlots] = useState<CVSlot[]>(() => configToSlots(cvs));
  const [activeCvIdx, setActiveCvIdx] = useState(0);
  const [activeAtomIdx, setActiveAtomIdx] = useState(0);

  // Re-init slots only when session changes (NOT when cvs prop changes from our own edits)
  const prevSessionRef = useRef(sessionId);
  useEffect(() => {
    if (sessionId !== prevSessionRef.current) {
      prevSessionRef.current = sessionId;
      setCvSlots(configToSlots(cvs));
      setActiveCvIdx(0);
      setActiveAtomIdx(0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Stable ref to onChange so we can call it from updateSlots without re-creating
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  /** Update internal state and notify parent — no effects, no loops */
  const updateSlots = useCallback((updater: (prev: CVSlot[]) => CVSlot[]) => {
    setCvSlots((prev) => {
      const next = updater(prev);
      // Notify parent outside of setState via microtask
      const configCvs = slotsToConfig(next);
      queueMicrotask(() => onChangeRef.current(configCvs));
      return next;
    });
  }, []);

  const pickTargetRef = useRef({ cvIdx: 0, atomIdx: 0 });
  useEffect(() => {
    pickTargetRef.current = { cvIdx: activeCvIdx, atomIdx: activeAtomIdx };
  }, [activeCvIdx, activeAtomIdx]);

  // Load structure file from session
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const { files } = await listFiles(sessionId);
        const lower = files.map((f) => ({ path: f, lc: f.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "" }));
        const topo =
          lower.find((f) => f.lc.endsWith("_ionized.gro")) ??
          lower.find((f) => f.lc.endsWith("_solvated.gro")) ??
          lower.find((f) => f.lc.endsWith("_system.gro")) ??
          lower.find((f) => f.lc.endsWith(".gro")) ??
          lower.find((f) => f.lc.endsWith(".pdb"));

        if (!topo) { if (!cancelled) setError("No structure file found"); return; }

        const content = await getFileContent(sessionId, topo.path);
        if (cancelled) return;

        const ext = topo.lc.split(".").pop() ?? "pdb";
        await initNGL(content, ext);
        if (!cancelled) { setReady(true); setLoading(false); }
      } catch (e) {
        console.error("InlineCVPicker load failed:", e);
        if (!cancelled) { setError(e instanceof Error ? e.message.split("\n")[0] : "Failed to load structure"); setLoading(false); }
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const initNGL = useCallback(async (content: string, ext: string) => {
    if (!window.NGL) {
      await new Promise<void>((resolve, reject) => {
        const existing = document.getElementById("ngl-script") as HTMLScriptElement | null;
        if (existing) {
          if (existing.dataset.loaded === "true" || window.NGL) { resolve(); return; }
          existing.addEventListener("load", () => resolve(), { once: true });
          existing.addEventListener("error", () => reject(new Error("NGL load failed")), { once: true });
          return;
        }
        const script = document.createElement("script");
        script.id = "ngl-script";
        script.src = "https://cdn.jsdelivr.net/npm/ngl/dist/ngl.js";
        script.async = true;
        script.addEventListener("load", () => { script.dataset.loaded = "true"; resolve(); }, { once: true });
        script.addEventListener("error", () => reject(new Error("NGL load failed")), { once: true });
        document.head.appendChild(script);
      });
    }

    if (!containerRef.current) return;

    roRef.current?.disconnect();
    roRef.current = null;
    if (stageRef.current) { stageRef.current.dispose(); stageRef.current = null; }
    componentRef.current = null;
    highlightRepsRef.current = [];
    containerRef.current.innerHTML = "";

    suppressNglDeprecationWarnings();
    const stage = new window.NGL.Stage(containerRef.current, { backgroundColor: theme === "dark" ? "#111827" : "#ffffff" });
    stageRef.current = stage;

    const ro = new ResizeObserver(() => stage.handleResize());
    ro.observe(containerRef.current);
    roRef.current = ro;

    const blob = new Blob([content], { type: "text/plain" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const component = await stage.loadFile(blob, { ext, defaultRepresentation: false, name: `structure.${ext}` }) as any;
    componentRef.current = component;

    component.addRepresentation("licorice", { colorScheme: "element" });
    component.addRepresentation("spacefill", { colorScheme: "element", radiusScale: 0.2 });
    component.autoView(500);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stage.signals.clicked.add((pickingProxy: any) => {
      if (!pickingProxy?.atom) return;
      const atom = pickingProxy.atom;
      handleAtomPicked({
        index: atom.index + 1,
        name: atom.atomname,
        resName: atom.resname,
        resSeq: atom.resno,
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stage.signals.hovered.add((pickingProxy: any) => {
      if (pickingProxy?.atom) {
        const a = pickingProxy.atom;
        setHoverInfo(`${a.resname}${a.resno}:${a.atomname} (#${a.index + 1})`);
      } else {
        setHoverInfo(null);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      roRef.current?.disconnect();
      roRef.current = null;
      if (stageRef.current) { stageRef.current.dispose(); stageRef.current = null; }
    };
  }, []);

  useEffect(() => {
    stageRef.current?.setParameters({ backgroundColor: theme === "dark" ? "#111827" : "#ffffff" });
  }, [theme]);

  const handleAtomPicked = useCallback((info: AtomInfo) => {
    const { cvIdx, atomIdx } = pickTargetRef.current;
    updateSlots((prev) => {
      const next = prev.map((cv, i) => {
        if (i !== cvIdx) return cv;
        const newAtoms = [...cv.atoms];
        newAtoms[atomIdx] = info;
        return { ...cv, atoms: newAtoms };
      });
      // Advance to next empty slot
      const cv = next[cvIdx];
      if (cv) {
        const nextEmpty = cv.atoms.findIndex((a, i) => i > atomIdx && a === null);
        if (nextEmpty !== -1) setActiveAtomIdx(nextEmpty);
      }
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateSlots]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shapeCompRef = useRef<any>(null);

  // Update highlights — only show atoms for the active (selected) CV
  useEffect(() => {
    if (!componentRef.current) return;
    // Remove old atom highlights
    for (const rep of highlightRepsRef.current) {
      try { componentRef.current.removeRepresentation(rep); } catch { /* ignore */ }
    }
    highlightRepsRef.current = [];
    // Remove old shape (cylinder)
    if (shapeCompRef.current) {
      try { stageRef.current?.removeComponent(shapeCompRef.current); } catch { /* ignore */ }
      shapeCompRef.current = null;
    }

    const cv = cvSlots[activeCvIdx];
    if (cv) {
      const color = CV_COLORS[activeCvIdx] ?? "#ffffff";
      // Highlight atoms with spacefill
      cv.atoms.forEach((atom) => {
        if (!atom) return;
        try {
          const rep = componentRef.current.addRepresentation("spacefill", {
            sele: `@${atom.index - 1}`,
            color,
            radiusScale: 0.5,
            opacity: 0.85,
          });
          highlightRepsRef.current.push(rep);
        } catch { /* ignore */ }
      });

      // For distance CVs with both atoms filled, draw a cylinder between them
      if (cv.type === "distance" && cv.atoms[0] && cv.atoms[1] && window.NGL && stageRef.current) {
        try {
          const structure = componentRef.current.structure;
          const ap1 = structure.getAtomProxy(cv.atoms[0].index - 1);
          const ap2 = structure.getAtomProxy(cv.atoms[1].index - 1);
          const pos1 = [ap1.x, ap1.y, ap1.z] as [number, number, number];
          const pos2 = [ap2.x, ap2.y, ap2.z] as [number, number, number];

          // Parse HSL or hex color to [r,g,b] 0-1
          const parseColor = (c: string): [number, number, number] => {
            const m = c.match(/hsl\(\s*(\d+),\s*(\d+)%,\s*(\d+)%\)/);
            if (m) {
              const h = Number(m[1]) / 360, s = Number(m[2]) / 100, l = Number(m[3]) / 100;
              const a2 = s * Math.min(l, 1 - l);
              const f = (n: number) => { const k = (n + h * 12) % 12; return l - a2 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
              return [f(0), f(8), f(4)];
            }
            if (c.startsWith("#") && c.length >= 7) {
              return [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255];
            }
            return [1, 0.6, 0];
          };

          const shape = new window.NGL.Shape("cv-distance");
          shape.addCylinder(pos1, pos2, parseColor(color), 0.08);
          const shapeComp = stageRef.current.addComponentFromObject(shape);
          shapeComp.addRepresentation("buffer", { opacity: 0.7 });
          shapeCompRef.current = shapeComp;
        } catch { /* ignore — structure may not support getAtomProxy */ }
      }
    }
    try { stageRef.current?.viewer?.requestRender?.(); } catch { /* ignore */ }
  }, [cvSlots, activeCvIdx, ready]);

  const addCV = () => {
    updateSlots((prev) => [...prev, makeEmptyCV(prev.length)]);
    setActiveCvIdx(cvSlots.length); // will be the new last index
    setActiveAtomIdx(0);
  };

  const removeCV = (idx: number) => {
    updateSlots((prev) => {
      const newSlots = prev.filter((_, i) => i !== idx).map((cv, i) => ({ ...cv, label: `CV${i + 1}` }));
      return newSlots.length === 0 ? [makeEmptyCV(0)] : newSlots;
    });
    setActiveCvIdx(Math.min(activeCvIdx, Math.max(0, cvSlots.length - 2)));
    setActiveAtomIdx(0);
  };

  const changeCVType = (cvIdx: number, newType: CVSlot["type"]) => {
    updateSlots((prev) =>
      prev.map((cv, i) => i !== cvIdx ? cv : { ...cv, type: newType, atoms: Array(REQUIRED_ATOMS[newType]).fill(null) })
    );
    setActiveCvIdx(cvIdx);
    setActiveAtomIdx(0);
  };

  /** Set atom by typed index (1-based) */
  const handleAtomTyped = (cvIdx: number, atomIdx: number, value: string) => {
    const idx = parseInt(value, 10);
    if (isNaN(idx) || idx < 1) return;
    const info: AtomInfo = { index: idx, name: `#${idx}`, resName: "?", resSeq: 0 };
    updateSlots((prev) => prev.map((cv, i) => {
      if (i !== cvIdx) return cv;
      const newAtoms = [...cv.atoms];
      newAtoms[atomIdx] = info;
      return { ...cv, atoms: newAtoms };
    }));
  };

  const [macroOpen, setMacroOpen] = useState(false);
  const [macroLoading, setMacroLoading] = useState<string | null>(null);

  const MACRO_OPTIONS = [
    { id: "all_ca_distance",         label: "All Cα distances",              desc: "Distance between every pair of Cα atoms" },
    { id: "consecutive_ca_distance", label: "Consecutive Cα distances",      desc: "Distance between adjacent Cα atoms along the chain" },
    { id: "backbone_torsion",        label: "Backbone torsion angles (φ/ψ)", desc: "φ and ψ dihedral angles for all residues" },
  ];

  const handleMacro = async (macroId: string) => {
    setMacroLoading(macroId);
    try {
      const res = await getMacroCvs(sessionId, macroId);
      if (res.cvs.length > 0) {
        // Convert to CVSlots and append
        const newSlots: CVSlot[] = res.cvs.map((cv, i) => {
          const pickerType = PLUMED_TO_PICKER[cv.type] ?? "distance";
          const needed = REQUIRED_ATOMS[pickerType];
          const atoms: (AtomInfo | null)[] = Array(needed).fill(null);
          for (let j = 0; j < Math.min(cv.atoms.length, needed); j++) {
            const idx = cv.atoms[j];
            if (idx > 0) atoms[j] = { index: idx, name: `#${idx}`, resName: "?", resSeq: 0 };
          }
          return { type: pickerType, atoms, label: cv.name || `CV${i + 1}` };
        });
        updateSlots((prev) => {
          // If only one empty CV, replace it; otherwise append
          const isEmpty = prev.length === 1 && prev[0].atoms.every((a) => a === null);
          return isEmpty ? newSlots : [...prev, ...newSlots];
        });
        setMacroOpen(false);
      }
    } catch (e) {
      console.error("Macro CV failed:", e);
    } finally {
      setMacroLoading(null);
    }
  };

  const activeCV = cvSlots[activeCvIdx];
  const pickingPrompt = activeCV
    ? `Click atom ${activeAtomIdx + 1} of ${REQUIRED_ATOMS[activeCV.type]} for ${activeCV.type} ${activeCV.label}`
    : "";

  return (
    <div className="flex gap-4 min-h-0">
      {/* Left: NGL viewer — square */}
      <div className="flex flex-col flex-shrink-0 rounded-xl border border-gray-300/60 dark:border-gray-700/60 bg-white dark:bg-gray-900 overflow-hidden" style={{ width: "360px", height: "400px" }}>
        <div className="flex-1 relative min-h-0">
          {loading && !ready && (
            <div className="absolute inset-0 flex items-center justify-center text-gray-400 z-10">
              <Loader2 size={18} className="animate-spin mr-2" />
              <span className="text-xs">Loading structure…</span>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-red-400 z-10 p-4">
              <span className="text-xs text-center">{error}</span>
            </div>
          )}
          <div ref={containerRef} className="w-full h-full" />
          {hoverInfo && ready && (
            <div className="absolute bottom-8 left-2 px-2 py-1 rounded-md bg-white/90 dark:bg-gray-900/90 border border-gray-200 dark:border-gray-700 text-xs text-gray-700 dark:text-gray-300 font-mono pointer-events-none">
              {hoverInfo}
            </div>
          )}
        </div>
        {/* Picking prompt bar */}
        <div className="px-3 py-2 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2 flex-shrink-0">
          <MousePointer2 size={11} className="text-gray-400 dark:text-gray-500" />
          <span className="text-[10px] text-gray-500 dark:text-gray-400">{pickingPrompt}</span>
        </div>
      </div>

      {/* Right: CV definition panel */}
      <div className="flex-1 flex flex-col min-w-0 rounded-xl border border-gray-300/60 dark:border-gray-700/60 bg-gray-50/80 dark:bg-gray-900/50 overflow-hidden" style={{ height: "400px" }}>
        <div className="px-3 py-2.5 border-b border-gray-200/60 dark:border-gray-800">
          <p className="text-[10px] text-gray-500 dark:text-gray-600">Click atoms on the 3D viewer or type atom indices directly.</p>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2" style={{ scrollbarWidth: "thin" }}>
          {cvSlots.map((cv, cvIdx) => {
            const color = CV_COLORS[cvIdx] ?? "#ffffff";
            const isActive = cvIdx === activeCvIdx;
            const isFilled = cv.atoms.every((a) => a !== null);

            return (
              <div
                key={cvIdx}
                className={`rounded-lg border transition-colors ${
                  isActive ? "bg-white/60 dark:bg-gray-800/40" : "border-gray-200/60 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700 bg-white/30 dark:bg-gray-800/20"
                }`}
                style={{ borderColor: isActive ? `${color}60` : undefined }}
              >
                {/* CV header */}
                <div
                  className="flex items-center justify-between px-3 py-2 cursor-pointer"
                  onClick={() => { setActiveCvIdx(cvIdx); setActiveAtomIdx(cv.atoms.findIndex((a) => a === null) ?? 0); }}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                    <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">{cv.label}</span>
                    {isFilled && (
                      <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">{shortCVLabel(cv)}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="relative">
                      <select
                        value={cv.type}
                        onChange={(e) => changeCVType(cvIdx, e.target.value as CVSlot["type"])}
                        className="appearance-none text-[10px] bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded pl-2 pr-5 py-1 text-gray-600 dark:text-gray-300 focus:outline-none cursor-pointer leading-tight"
                      >
                        {CV_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                      <ChevronDown size={9} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    </div>
                    {cvSlots.length > 1 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); removeCV(cvIdx); }}
                        className="p-0.5 rounded text-gray-400 dark:text-gray-600 hover:text-red-400 transition-colors"
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Atom slots — clickable + typeable */}
                <div className="px-3 pb-2.5 space-y-1">
                  {cv.atoms.map((atom, atomIdx) => {
                    const isPickTarget = isActive && atomIdx === activeAtomIdx;
                    return (
                      <div
                        key={atomIdx}
                        onClick={() => { setActiveCvIdx(cvIdx); setActiveAtomIdx(atomIdx); }}
                        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors text-xs ${
                          isPickTarget
                            ? "bg-gray-200/60 dark:bg-gray-700/60"
                            : atom
                              ? "bg-gray-100/40 dark:bg-gray-800/40 hover:bg-gray-200/40 dark:hover:bg-gray-800/60"
                              : "bg-gray-100/20 dark:bg-gray-800/20 hover:bg-gray-200/40 dark:hover:bg-gray-800/40 border border-dashed border-gray-300/60 dark:border-gray-700"
                        }`}
                        style={isPickTarget ? { outlineColor: color, outlineWidth: "1px", outlineStyle: "solid" } : undefined}
                      >
                        <span className="text-[10px] text-gray-400 dark:text-gray-500 w-10 flex-shrink-0">Atom {atomIdx + 1}</span>
                        {atom ? (
                          <span className="font-mono text-gray-700 dark:text-gray-300 flex-1">{atomLabel(atom)}</span>
                        ) : (
                          <span className="text-gray-400 dark:text-gray-600 italic flex-1">
                            {isPickTarget ? "Click on molecule…" : "—"}
                          </span>
                        )}
                        {/* Typeable index input */}
                        <input
                          type="number"
                          min={1}
                          value={atom?.index ?? ""}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => handleAtomTyped(cvIdx, atomIdx, e.target.value)}
                          onFocus={() => { setActiveCvIdx(cvIdx); setActiveAtomIdx(atomIdx); }}
                          placeholder="#"
                          className="w-14 text-right text-[10px] font-mono bg-white/60 dark:bg-gray-800/60 border border-gray-200/60 dark:border-gray-700/60 rounded px-1.5 py-0.5 text-gray-600 dark:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 placeholder-gray-300 dark:placeholder-gray-700 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Bottom: Add CV + Macro */}
        <div className="px-3 py-2.5 border-t border-gray-200/60 dark:border-gray-800 flex-shrink-0 relative">
          <div className="flex gap-1.5">
            <button
              onClick={addCV}
              className="flex-1 py-1.5 rounded-lg text-[10px] font-medium border border-dashed border-gray-300 dark:border-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 transition-colors flex items-center justify-center gap-1"
            >
              <Plus size={10} />
              Add CV
            </button>
            <button
              onClick={() => setMacroOpen((v) => !v)}
              className="flex-1 py-1.5 rounded-lg text-[10px] font-medium border border-dashed border-amber-300 dark:border-amber-700 text-amber-500 hover:text-amber-600 dark:hover:text-amber-400 hover:border-amber-400 dark:hover:border-amber-500 transition-colors flex items-center justify-center gap-1"
            >
              <Zap size={10} />
              Macro
            </button>
          </div>

          {/* Macro popup */}
          {macroOpen && (
            <div className="absolute bottom-full right-0 mb-1.5 w-72 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl z-30 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-800">
                <span className="text-[10px] font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wider">CV Macros</span>
                <button onClick={() => setMacroOpen(false)} className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                  <X size={10} />
                </button>
              </div>
              <div className="p-1.5 space-y-0.5">
                {MACRO_OPTIONS.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => handleMacro(m.id)}
                    disabled={macroLoading !== null}
                    className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50 group"
                  >
                    <div className="flex items-center gap-2">
                      {macroLoading === m.id ? (
                        <Loader2 size={10} className="animate-spin text-amber-500 flex-shrink-0" />
                      ) : (
                        <Zap size={10} className="text-amber-400 flex-shrink-0" />
                      )}
                      <span className="text-xs font-medium text-gray-700 dark:text-gray-200 group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors">{m.label}</span>
                    </div>
                    <p className="text-[9px] text-gray-400 dark:text-gray-600 mt-0.5 ml-[18px]">{m.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
