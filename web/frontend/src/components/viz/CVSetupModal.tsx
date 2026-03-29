"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X, Loader2, Plus, Trash2, MousePointer2, ChevronDown } from "lucide-react";
import { suppressNglDeprecationWarnings } from "@/lib/ngl";
import { getFileContent, listFiles } from "@/lib/api";
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

export interface CVDefinitionOut {
  type: "distance" | "angle" | "dihedral";
  atoms: number[];
  label: string;
}

const REQUIRED_ATOMS: Record<CVSlot["type"], number> = { distance: 2, angle: 3, dihedral: 4 };
const CV_COLORS = CV_PALETTE;
const CV_TYPE_OPTIONS: { value: CVSlot["type"]; label: string; desc: string }[] = [
  { value: "distance", label: "Distance", desc: "2 atoms" },
  { value: "angle",    label: "Angle",    desc: "3 atoms" },
  { value: "dihedral", label: "Dihedral", desc: "4 atoms" },
];

function makeEmptyCV(index: number, type: CVSlot["type"] = "distance"): CVSlot {
  return {
    type,
    atoms: Array(REQUIRED_ATOMS[type]).fill(null),
    label: `CV${index + 1}`,
  };
}

function atomLabel(a: AtomInfo): string {
  return `${a.resName}${a.resSeq}:${a.name}`;
}

function shortCVLabel(cv: CVSlot): string {
  const filled = cv.atoms.filter(Boolean) as AtomInfo[];
  const ids = filled.map((a) => a.index).join(",");
  if (cv.type === "distance") return `d(${ids})`;
  if (cv.type === "angle") return `∠(${ids})`;
  return `τ(${ids})`;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    NGL: any;
  }
}

interface Props {
  sessionId: string;
  onConfirm: (cvs: CVDefinitionOut[]) => void;
  onClose: () => void;
}

export default function CVSetupModal({ sessionId, onConfirm, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stageRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const componentRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const highlightRepsRef = useRef<any[]>([]);

  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoverInfo, setHoverInfo] = useState<string | null>(null);


  const [cvSlots, setCvSlots] = useState<CVSlot[]>([makeEmptyCV(0)]);
  const [activeCvIdx, setActiveCvIdx] = useState(0);
  const [activeAtomIdx, setActiveAtomIdx] = useState(0);

  // Ref to always have current picking target in the NGL callback
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
        // Find topology (same priority as ProgressTab)
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
        console.error("CVSetupModal load failed:", e); if (!cancelled) { setError(e instanceof Error ? e.message.split("\n")[0] : "Failed to load structure"); setLoading(false); }
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const initNGL = useCallback(async (content: string, ext: string) => {
    // Ensure NGL is loaded
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

    if (stageRef.current) { stageRef.current.dispose(); stageRef.current = null; }
    componentRef.current = null;
    highlightRepsRef.current = [];
    containerRef.current.innerHTML = "";

    suppressNglDeprecationWarnings();
    const stage = new window.NGL.Stage(containerRef.current, { backgroundColor: "transparent" });
    stageRef.current = stage;

    const ro = new ResizeObserver(() => stage.handleResize());
    ro.observe(containerRef.current);

    const blob = new Blob([content], { type: "text/plain" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const component = await stage.loadFile(blob, { ext, defaultRepresentation: false, name: `structure.${ext}` }) as any;
    componentRef.current = component;

    // Ball-and-stick representation
    component.addRepresentation("licorice", { colorScheme: "element" });
    component.addRepresentation("spacefill", { colorScheme: "element", radiusScale: 0.2 });
    component.autoView(500);

    // Atom picking
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stage.signals.clicked.add((pickingProxy: any) => {
      if (!pickingProxy?.atom) return;
      const atom = pickingProxy.atom;
      const info: AtomInfo = {
        index: atom.index + 1,
        name: atom.atomname,
        resName: atom.resname,
        resSeq: atom.resno,
      };
      handleAtomPicked(info);
    });

    // Hover tooltip
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

  // Cleanup NGL on unmount
  useEffect(() => {
    return () => {
      if (stageRef.current) { stageRef.current.dispose(); stageRef.current = null; }
    };
  }, []);

  const handleAtomPicked = useCallback((info: AtomInfo) => {
    const { cvIdx, atomIdx } = pickTargetRef.current;
    setCvSlots((prev) => {
      const next = prev.map((cv, i) => {
        if (i !== cvIdx) return cv;
        const newAtoms = [...cv.atoms];
        newAtoms[atomIdx] = info;
        return { ...cv, atoms: newAtoms };
      });
      return next;
    });
    // Advance to next empty slot
    setCvSlots((prev) => {
      const cv = prev[cvIdx];
      if (!cv) return prev;
      const nextEmpty = cv.atoms.findIndex((a, i) => i > atomIdx && a === null);
      if (nextEmpty !== -1) {
        setActiveAtomIdx(nextEmpty);
      }
      return prev;
    });
  }, []);

  // Update highlights when cvSlots change
  useEffect(() => {
    if (!componentRef.current) return;
    // Remove old highlights
    for (const rep of highlightRepsRef.current) {
      try { componentRef.current.removeRepresentation(rep); } catch { /* ignore */ }
    }
    highlightRepsRef.current = [];

    // Add new highlights
    cvSlots.forEach((cv, cvIdx) => {
      const color = CV_COLORS[cvIdx] ?? "#ffffff";
      cv.atoms.forEach((atom) => {
        if (!atom) return;
        const idx0 = atom.index - 1;
        try {
          const rep = componentRef.current.addRepresentation("spacefill", {
            sele: `@${idx0}`,
            color,
            radiusScale: 0.5,
            opacity: 0.85,
          });
          highlightRepsRef.current.push(rep);
        } catch { /* ignore */ }
      });
    });
    try { stageRef.current?.viewer?.requestRender?.(); } catch { /* ignore */ }
  }, [cvSlots]);

  // Escape key
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const addCV = () => {
    if (cvSlots.length >= 3) return;
    const newSlots = [...cvSlots, makeEmptyCV(cvSlots.length)];
    setCvSlots(newSlots);
    setActiveCvIdx(newSlots.length - 1);
    setActiveAtomIdx(0);
  };

  const removeCV = (idx: number) => {
    const newSlots = cvSlots.filter((_, i) => i !== idx).map((cv, i) => ({
      ...cv,
      label: `CV${i + 1}`,
    }));
    setCvSlots(newSlots.length === 0 ? [makeEmptyCV(0)] : newSlots);
    const newActive = Math.min(activeCvIdx, (newSlots.length || 1) - 1);
    setActiveCvIdx(newActive);
    setActiveAtomIdx(0);
  };

  const changeCVType = (cvIdx: number, newType: CVSlot["type"]) => {
    setCvSlots((prev) =>
      prev.map((cv, i) =>
        i !== cvIdx ? cv : { ...cv, type: newType, atoms: Array(REQUIRED_ATOMS[newType]).fill(null) }
      )
    );
    setActiveCvIdx(cvIdx);
    setActiveAtomIdx(0);
  };

  const setPickTarget = (cvIdx: number, atomIdx: number) => {
    setActiveCvIdx(cvIdx);
    setActiveAtomIdx(atomIdx);
  };

  const isComplete = cvSlots.some((cv) => cv.atoms.every((a) => a !== null));

  const handleConfirm = () => {
    const completeCVs = cvSlots.filter((cv) => cv.atoms.every((a) => a !== null));
    if (completeCVs.length === 0) return;
    const out: CVDefinitionOut[] = completeCVs.map((cv) => ({
      type: cv.type,
      atoms: cv.atoms.map((a) => a!.index),
      label: cv.label,
    }));
    onConfirm(out);
  };

  // Determine picking prompt text
  const activeCV = cvSlots[activeCvIdx];
  const pickingPrompt = activeCV
    ? `Click atom ${activeAtomIdx + 1} of ${REQUIRED_ATOMS[activeCV.type]} for ${activeCV.type} ${activeCV.label}`
    : "";

  return (
    <div className="fixed inset-0 z-60 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-2xl flex flex-col overflow-hidden"
        style={{ width: "min(1100px, 95vw)", height: "min(680px, 90vh)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 bg-gray-50 dark:bg-gray-800/80 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Custom CV Analysis</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Body: two columns */}
        <div className="flex-1 flex min-h-0">
          {/* Left: NGL viewer */}
          <div className="flex-1 flex flex-col min-w-0 border-r border-gray-200 dark:border-gray-800">
            <div className="flex-1 relative min-h-0">
              {loading && !ready && (
                <div className="absolute inset-0 flex items-center justify-center text-gray-400 z-10">
                  <Loader2 size={24} className="animate-spin mr-2" />
                  <span className="text-sm">Loading structure…</span>
                </div>
              )}
              {error && (
                <div className="absolute inset-0 flex items-center justify-center text-red-400 z-10 p-4">
                  <span className="text-sm text-center">{error}</span>
                </div>
              )}
              <div ref={containerRef} className="w-full h-full" />
              {/* Hover tooltip */}
              {hoverInfo && ready && (
                <div className="absolute bottom-2 left-2 px-2 py-1 rounded-md bg-white/90 dark:bg-gray-900/90 border border-gray-200 dark:border-gray-700 text-xs text-gray-700 dark:text-gray-300 font-mono pointer-events-none">
                  {hoverInfo}
                </div>
              )}
            </div>
            {/* Picking prompt bar */}
            <div className="px-3 py-2 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2 flex-shrink-0">
              <MousePointer2 size={12} className="text-gray-400 dark:text-gray-500" />
              <span className="text-[11px] text-gray-500 dark:text-gray-400">{pickingPrompt}</span>
            </div>
          </div>

          {/* Right: CV definition panel */}
          <div className="w-[360px] flex-shrink-0 flex flex-col bg-gray-50/50 dark:bg-gray-900/50">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-500 uppercase tracking-wider">Collective Variables</p>
              <p className="text-[10px] text-gray-400 dark:text-gray-600 mt-0.5">Define up to 3 CVs. Click atoms on the viewer to select.</p>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2" style={{ scrollbarWidth: "thin" }}>
              {cvSlots.map((cv, cvIdx) => {
                const color = CV_COLORS[cvIdx] ?? "#ffffff";
                const isActive = cvIdx === activeCvIdx;
                const isFilled = cv.atoms.every((a) => a !== null);

                return (
                  <div
                    key={cvIdx}
                    className={`rounded-xl border transition-colors ${
                      isActive ? "border-opacity-60" : "border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700"
                    }`}
                    style={isActive ? { borderColor: `${color}60` } : undefined}
                  >
                    {/* CV header */}
                    <div
                      className="flex items-center justify-between px-3 py-2 cursor-pointer"
                      onClick={() => { setActiveCvIdx(cvIdx); setActiveAtomIdx(cv.atoms.findIndex((a) => a === null) ?? 0); }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                        <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">{cv.label}</span>
                        {isFilled && (
                          <span className="text-[10px] text-gray-500 font-mono">{shortCVLabel(cv)}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {/* Type selector */}
                        <div className="relative">
                          <select
                            value={cv.type}
                            onChange={(e) => changeCVType(cvIdx, e.target.value as CVSlot["type"])}
                            className="appearance-none text-[10px] bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-md pl-2 pr-5 py-0.5 text-gray-700 dark:text-gray-300 focus:outline-none focus:border-blue-500 cursor-pointer"
                          >
                            {CV_TYPE_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                          <ChevronDown size={10} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                        </div>
                        {cvSlots.length > 1 && (
                          <button
                            onClick={(e) => { e.stopPropagation(); removeCV(cvIdx); }}
                            className="p-0.5 rounded text-gray-600 hover:text-red-400 transition-colors"
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Atom slots */}
                    <div className="px-3 pb-2.5 space-y-1">
                      {cv.atoms.map((atom, atomIdx) => {
                        const isPickTarget = isActive && atomIdx === activeAtomIdx;
                        return (
                          <div
                            key={atomIdx}
                            onClick={() => setPickTarget(cvIdx, atomIdx)}
                            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors text-xs ${
                              isPickTarget
                                ? "bg-gray-200/60 dark:bg-gray-700/60"
                                : atom
                                  ? "bg-gray-100/40 dark:bg-gray-800/40 hover:bg-gray-200/60 dark:hover:bg-gray-800/60"
                                  : "bg-gray-100/20 dark:bg-gray-800/20 hover:bg-gray-200/40 dark:hover:bg-gray-800/40 border border-dashed border-gray-300 dark:border-gray-700"
                            }`}
                            style={isPickTarget ? { outlineColor: color, outlineWidth: "1px", outlineStyle: "solid" } : undefined}
                          >
                            <span className="text-[10px] text-gray-500 w-12 flex-shrink-0">Atom {atomIdx + 1}</span>
                            {atom ? (
                              <>
                                <span className="font-mono text-gray-700 dark:text-gray-300">{atomLabel(atom)}</span>
                                <span className="text-[10px] text-gray-400 dark:text-gray-600 ml-auto">#{atom.index}</span>
                              </>
                            ) : (
                              <span className="text-gray-400 dark:text-gray-600 italic">
                                {isPickTarget ? "Click on molecule…" : "Click to select"}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Bottom controls */}
            <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-800 space-y-2 flex-shrink-0">
              <button
                onClick={addCV}
                disabled={cvSlots.length >= 3}
                className="w-full py-1.5 rounded-lg text-xs font-medium border border-dashed border-gray-300 dark:border-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
              >
                <Plus size={12} />
                Add CV ({cvSlots.length}/3)
              </button>
              <button
                onClick={handleConfirm}
                disabled={!isComplete}
                className="w-full py-2.5 rounded-xl text-xs font-semibold transition-colors bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Compute & Add to Results
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
