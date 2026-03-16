"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Camera, Crosshair, Film, Loader2, Pause, Play, Settings, X } from "lucide-react";
import { downloadUrl, getFileContent } from "@/lib/api";
import { suppressNglDeprecationWarnings } from "@/lib/ngl";
import { useTheme } from "@/lib/theme";

type ExportBg = "white" | "black" | "transparent";

/**
 * Capture an image from an NGL stage with the chosen background.
 * Temporarily swaps the stage background colour, captures, then restores.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function captureImage(stage: any, bg: ExportBg, opts: Record<string, unknown> = {}): Promise<Blob> {
  const isTransparent = bg === "transparent";
  const originalBg = stage.getParameters().backgroundColor;
  if (!isTransparent) stage.setParameters({ backgroundColor: bg });
  try {
    return await stage.makeImage({ transparent: isTransparent, ...opts });
  } finally {
    stage.setParameters({ backgroundColor: originalBg });
  }
}

interface Props {
  sessionId: string;
  topologyPath: string | null;
  trajectoryPath: string | null;
  /** True while the parent is still fetching the file list */
  isLoading?: boolean;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    NGL: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    GIF: any;
  }
}

type LoadingStage = "ngl" | "topology" | "trajectory" | "frames" | null;

const LOADING_LABELS: Record<NonNullable<LoadingStage>, string> = {
  ngl:        "Loading viewer…",
  topology:   "Loading structure…",
  trajectory: "Loading trajectory…",
  frames:     "Reading frames…",
};

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

/** Base64url-encode a JSON payload for embedding in a URL path segment. */
function encodePathsB64(xtc: string, top: string): string {
  return btoa(JSON.stringify({ xtc, top }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export default function TrajectoryViewer({ sessionId, topologyPath, trajectoryPath, isLoading = false }: Props) {
  const containerRef     = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stageRef         = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const componentRef     = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playerRef        = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trajectoryRef    = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initialOrientRef = useRef<any>(null);
  const repsRef          = useRef({ ball: true, stick: true, ribbon: false, surface: false });

  const [reps, setReps] = useState(repsRef.current);
  useEffect(() => { repsRef.current = reps; }, [reps]);
  const { theme } = useTheme();

  const [ready, setReady]               = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [loadingStage, setLoadingStage] = useState<LoadingStage>("ngl");
  const [playing, setPlaying]           = useState(false);
  const [frame, setFrame]               = useState(0);
  const [totalFrames, setTotalFrames]   = useState<number | null>(null);
  const [structInfo, setStructInfo]     = useState<{ atoms: number; residues: number } | null>(null);
  const [gifGenerating, setGifGenerating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef                     = useRef<HTMLDivElement>(null);

  const [exportSettings, setExportSettings] = useState({
    screenshot: { factor: 6, antialias: true,  trim: false, background: "white" as ExportBg },
    gif:        { factor: 1, antialias: true, trim: false, background: "white" as ExportBg, maxFrames: 60, frameDelay: 80 },
  });

  // Close settings panel on outside click
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyRepresentations = (component: any, currentReps?: typeof reps) => {
    const r = currentReps ?? repsRef.current;
    component.removeAllRepresentations();
    if (r.ball)    component.addRepresentation("spacefill", { colorScheme: "element", radiusScale: 0.2 });
    if (r.stick)   component.addRepresentation("licorice",  { colorScheme: "element" });
    if (r.ribbon)  component.addRepresentation("cartoon",   { sele: "protein", colorScheme: "residueindex" });
    if (r.surface) component.addRepresentation("surface",   { color: "white", opacity: 0.1 });
  };

  useEffect(() => {
    if (!componentRef.current) return;
    applyRepresentations(componentRef.current);
  }, [reps]);

  useEffect(() => {
    let ro: ResizeObserver | null = null;
    let cancelled = false;
    setReady(false);
    setError(null);
    setPlaying(false);
    setFrame(0);
    setTotalFrames(null);
    setStructInfo(null);
    initialOrientRef.current = null;
    trajectoryRef.current = null;

    // No paths yet — keep canvas in a waiting state, don't init NGL
    if (!topologyPath || !trajectoryPath) {
      setLoadingStage(null);
      return;
    }

    setLoadingStage("ngl");

    // Fetch topology content in parallel for the struct-info overlay
    getFileContent(sessionId, topologyPath)
      .then((content) => {
        if (!cancelled) {
          const name = topologyPath.split("/").pop() ?? topologyPath;
          setStructInfo(parseStructureInfo(content, name));
        }
      })
      .catch(() => { /* overlay is optional */ });

    const init = () => {
      if (!containerRef.current || !window.NGL || cancelled) return;

      // NGL 2.4+ requires TrajectoryDatasource to be configured before addTrajectory.
      // We set it to route through our backend endpoints.
      window.NGL.TrajectoryDatasource = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getCountUrl: (trajPath: string) => `${trajPath}/numframes`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getFrameUrl: (trajPath: string, frameIndex: number) => `${trajPath}/frame/${frameIndex}`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getFrameParams: (_trajPath: string, atomIndices: any) =>
          atomIndices?.length
            ? `atomIndices=${(atomIndices as number[][]).map((r) => r.join(",")).join(";")}`
            : "",
      };

      suppressNglDeprecationWarnings();
      const stage = new window.NGL.Stage(containerRef.current, { backgroundColor: theme === "dark" ? "#111827" : "#ffffff" });
      stageRef.current = stage;
      ro = new ResizeObserver(() => stage.handleResize());
      ro.observe(containerRef.current);

      const topologyExt = topologyPath.split(".").pop()?.toLowerCase() || "gro";
      const topologyUrl = downloadUrl(sessionId, topologyPath);

      // Build the NGL RemoteTrajectory base URL.
      // NGL appends "/numframes" and "/frame/{i}" to this URL.
      // We encode both paths in base64url to avoid query-string conflicts.
      const combined    = encodePathsB64(trajectoryPath, topologyPath);
      const trajApiBase = `/api/sessions/${sessionId}/ngl-traj/${combined}`;

      setLoadingStage("topology");
      stage
        .loadFile(topologyUrl, {
          ext: topologyExt,
          defaultRepresentation: false,
          name: topologyPath.split("/").pop() || "topology",
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((comp: any) => {
          if (cancelled) return;
          componentRef.current = comp;
          comp.autoView(600);
          setTimeout(() => {
            try { initialOrientRef.current = stage.viewerControls.getOrientation(); } catch { /* ignore */ }
          }, 650);

          setLoadingStage("trajectory");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const trajComp = comp.addTrajectory(trajApiBase, { centerPbc: true, removePbc: true } as any);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const traj = trajComp?.trajectory as any;
          trajectoryRef.current = traj;
          if (traj?.signals?.frameChanged) {
            traj.signals.frameChanged.add((i: number) => setFrame(i));
          }

          const initPlayer = (n: number) => {
            if (cancelled) return;
            setTotalFrames(Number(n));
            applyRepresentations(comp, repsRef.current);
            playerRef.current = new window.NGL.TrajectoryPlayer(traj, { step: 1, timeout: 80, mode: "loop" });
            setLoadingStage(null);
            setReady(true);
          };

          if (traj?.numframes) {
            initPlayer(traj.numframes);
          } else if (traj?.signals?.countChanged) {
            setLoadingStage("frames");
            traj.signals.countChanged.add(initPlayer);
          } else {
            applyRepresentations(comp, repsRef.current);
            playerRef.current = new window.NGL.TrajectoryPlayer(traj, { step: 1, timeout: 80, mode: "loop" });
            setLoadingStage(null);
            setReady(true);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setLoadingStage(null);
            setError(String(e));
          }
        });
    };

    let scriptEl: HTMLScriptElement | null = null;
    let loadHandler: (() => void) | null = null;

    if (window.NGL) {
      init();
    } else {
      const existing = document.getElementById("ngl-script") as HTMLScriptElement | null;
      if (existing) {
        scriptEl = existing;
        if (window.NGL || existing.dataset.loaded === "true") {
          init();
        } else {
          loadHandler = () => { existing.dataset.loaded = "true"; init(); };
          existing.addEventListener("load", loadHandler, { once: true });
        }
      } else {
        const script = document.createElement("script");
        scriptEl = script;
        script.id    = "ngl-script";
        script.src   = "https://cdn.jsdelivr.net/npm/ngl/dist/ngl.js";
        script.async = true;
        loadHandler = () => { script.dataset.loaded = "true"; init(); };
        script.addEventListener("load", loadHandler, { once: true });
        document.head.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
      if (scriptEl && loadHandler) scriptEl.removeEventListener("load", loadHandler);
      try { playerRef.current?.pause?.(); } catch { /* ignore */ }
      ro?.disconnect();
      if (stageRef.current) { stageRef.current.dispose(); stageRef.current = null; }
      componentRef.current    = null;
      playerRef.current       = null;
      trajectoryRef.current   = null;
      initialOrientRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, topologyPath, trajectoryPath]);

  // Update NGL background when theme changes
  useEffect(() => {
    stageRef.current?.setParameters({ backgroundColor: theme === "dark" ? "#111827" : "#ffffff" });
  }, [theme]);

  const handlePlay = () => {
    if (!playerRef.current) return;
    playerRef.current.play();
    setPlaying(true);
  };

  const handlePause = () => {
    if (!playerRef.current) return;
    playerRef.current.pause();
    setPlaying(false);
  };

  const handleSeek = (nextFrame: number) => {
    if (!trajectoryRef.current) return;
    const n = totalFrames ?? 0;
    if (n <= 0) return;
    const clamped = Math.max(0, Math.min(n - 1, nextFrame));
    try {
      playerRef.current?.pause?.();
      setPlaying(false);
      trajectoryRef.current.setFrame(clamped);
      setFrame(clamped);
    } catch { /* ignore */ }
  };

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
    const { background, ...opts } = exportSettings.screenshot;
    const blob = await captureImage(stageRef.current, background, opts);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    const base = (topologyPath ?? "").split("/").pop()?.replace(/\.[^.]+$/, "") || "trajectory";
    a.href     = url;
    a.download = `${base}_trajectory_view.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleGifExport = async () => {
    if (!stageRef.current || !trajectoryRef.current || !totalFrames || totalFrames <= 0) return;
    setGifGenerating(true);

    // Pause player
    playerRef.current?.pause?.();
    setPlaying(false);

    let workerBlobUrl: string | null = null;

    try {
      // Load gif.js from CDN if not already loaded
      await new Promise<void>((resolve, reject) => {
        if (window.GIF) { resolve(); return; }
        const existing = document.getElementById("gif-script");
        if (existing) {
          if (window.GIF) { resolve(); return; }
          existing.addEventListener("load", () => resolve(), { once: true });
          existing.addEventListener("error", reject, { once: true });
          return;
        }
        const s = document.createElement("script");
        s.id  = "gif-script";
        s.src = "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js";
        s.onload  = () => resolve();
        s.onerror = reject;
        document.head.appendChild(s);
      });

      // Fetch the worker script and create a same-origin blob URL to bypass CORS restrictions
      // (browsers block new Worker(cross-origin-url) without CORP headers)
      const workerResp = await fetch("https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js");
      if (!workerResp.ok) throw new Error("Failed to fetch GIF worker script");
      workerBlobUrl = URL.createObjectURL(await workerResp.blob());

      const GIF = window.GIF;
      const container = containerRef.current!;
      const gif = new GIF({
        workers: 2,
        quality: 10,
        workerScript: workerBlobUrl,
        width:  container.clientWidth,
        height: container.clientHeight,
      });

      const n = totalFrames;
      const maxFrames = Math.min(n, exportSettings.gif.maxFrames);
      const step = Math.max(1, Math.floor(n / maxFrames));

      for (let i = 0; i < n; i += step) {
        // Wait for the frame to actually render (frameChanged signal + render delay)
        await new Promise<void>((resolveFrame) => {
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            try { trajectoryRef.current?.signals?.frameChanged?.remove(onFrameChanged); } catch { /* ignore */ }
            // Extra render delay after frame data arrives
            setTimeout(resolveFrame, 120);
          };
          const onFrameChanged = () => settle();
          try {
            trajectoryRef.current?.signals?.frameChanged?.add(onFrameChanged);
          } catch { /* ignore */ }
          trajectoryRef.current!.setFrame(i);
          // Fallback: resolve after 2 s if frameChanged never fires
          setTimeout(() => settle(), 2000);
        });

        const { background: gifBg, maxFrames: _mf, frameDelay: _fd, ...gifOpts } = exportSettings.gif;
        const blob: Blob = await captureImage(stageRef.current!, gifBg, gifOpts);
        const imgUrl = URL.createObjectURL(blob);
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            gif.addFrame(img, { delay: exportSettings.gif.frameDelay, copy: true });
            URL.revokeObjectURL(imgUrl);
            resolve();
          };
          img.src = imgUrl;
        });
      }

      await new Promise<void>((resolve, reject) => {
        gif.on("finished", (blob: Blob) => {
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement("a");
          const base = (topologyPath ?? "").split("/").pop()?.replace(/\.[^.]+$/, "") || "trajectory";
          a.href     = url;
          a.download = `${base}_trajectory.gif`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          resolve();
        });
        gif.on("error", (err: unknown) => reject(new Error(String(err))));
        gif.render();
      });
    } catch (err) {
      console.error("GIF export failed:", err);
    } finally {
      if (workerBlobUrl) URL.revokeObjectURL(workerBlobUrl);
      setGifGenerating(false);
    }
  };

  return (
    <div className="space-y-2">
      {/* Viewer canvas */}
      <div
        className="relative rounded-xl border border-gray-300/60 dark:border-gray-700/60 bg-white dark:bg-gray-900 overflow-hidden"
        style={{ height: "360px" }}
      >
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-red-400 gap-2 z-10">
            <AlertCircle size={18} />
            <span className="text-xs px-4 text-center break-all">{error}</span>
          </div>
        ) : isLoading || !topologyPath || !trajectoryPath ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-500 gap-2 z-10">
            {isLoading ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                <span className="text-xs">Loading trajectory…</span>
              </>
            ) : (
              <span className="text-xs text-gray-400 dark:text-gray-600 px-4 text-center">No trajectory data yet.</span>
            )}
          </div>
        ) : loadingStage ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 gap-2 z-10">
            <Loader2 size={18} className="animate-spin" />
            <span className="text-xs">{LOADING_LABELS[loadingStage]}</span>
          </div>
        ) : null}
        <div ref={containerRef} className="w-full h-full" />

        {/* Upper-left overlay: atom/residue counts */}
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
          {[
            { key: "ball",    label: "Ball"    },
            { key: "stick",   label: "Stick"   },
            { key: "ribbon",  label: "Cartoon" },
            { key: "surface", label: "Surface" },
          ].map(({ key, label }) => {
            const on = reps[key as keyof typeof reps];
            return (
              <button
                key={key}
                onClick={() => setReps((r) => ({ ...r, [key]: !r[key as keyof typeof r] }))}
                disabled={!ready || gifGenerating}
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
            onClick={handlePlay}
            disabled={!ready || playing || gifGenerating}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border border-emerald-300/60 dark:border-emerald-700/60 bg-emerald-50/60 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100/60 dark:hover:bg-emerald-800/40 disabled:opacity-40"
          >
            <Play size={11} />
            Play
          </button>
          <button
            onClick={handlePause}
            disabled={!ready || !playing || gifGenerating}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border border-amber-300/60 dark:border-amber-700/60 bg-amber-50/60 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-100/60 dark:hover:bg-amber-800/40 disabled:opacity-40"
          >
            <Pause size={11} />
            Pause
          </button>
          <button
            onClick={handleResetView}
            disabled={!ready || gifGenerating}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border border-gray-300/60 dark:border-gray-700/60 bg-gray-100/60 dark:bg-gray-800/60 text-gray-700 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 disabled:opacity-40"
          >
            <Crosshair size={11} />
            Reset
          </button>
          <button
            onClick={handleScreenshot}
            disabled={!ready || gifGenerating}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border border-gray-300/60 dark:border-gray-700/60 bg-gray-100/60 dark:bg-gray-800/60 text-gray-700 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 disabled:opacity-40"
          >
            <Camera size={11} />
            Screenshot
          </button>
          <button
            onClick={handleGifExport}
            disabled={!ready || gifGenerating || !totalFrames}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border border-purple-300/60 dark:border-purple-700/60 bg-purple-50/60 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 hover:bg-purple-100/60 dark:hover:bg-purple-800/40 disabled:opacity-40"
          >
            {gifGenerating
              ? <Loader2 size={11} className="animate-spin" />
              : <Film size={11} />
            }
            {gifGenerating ? "Exporting…" : "GIF"}
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
              <div className="absolute right-0 bottom-full mb-2 z-50 w-72 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl text-xs overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800/80 border-b border-gray-200 dark:border-gray-700">
                  <span className="font-semibold text-gray-700 dark:text-gray-200">Export Settings</span>
                  <button onClick={() => setSettingsOpen(false)} className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-200 transition-colors">
                    <X size={12} />
                  </button>
                </div>

                <div className="p-3 space-y-4">
                  {/* ── Screenshot ── */}
                  <div>
                    <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">Screenshot</p>
                    <div className="space-y-2">
                      {/* Factor */}
                      <div className="flex items-center gap-2">
                        <span className="w-24 text-gray-500 dark:text-gray-400 flex-shrink-0">Factor</span>
                        <input
                          type="range" min={1} max={8} step={1}
                          value={exportSettings.screenshot.factor}
                          onChange={(e) => setExportSettings((s) => ({ ...s, screenshot: { ...s.screenshot, factor: Number(e.target.value) } }))}
                          className="flex-1 accent-indigo-500 h-1"
                        />
                        <span className="w-5 text-right text-gray-700 dark:text-gray-300 tabular-nums">{exportSettings.screenshot.factor}×</span>
                      </div>
                      {/* Booleans */}
                      {(["antialias", "trim"] as const).map((key) => (
                        <div key={key} className="flex items-center justify-between">
                          <span className="text-gray-500 dark:text-gray-400 capitalize">{key}</span>
                          <button
                            onClick={() => setExportSettings((s) => ({ ...s, screenshot: { ...s.screenshot, [key]: !s.screenshot[key] } }))}
                            className={`w-8 h-4 rounded-full transition-colors relative flex-shrink-0 ${exportSettings.screenshot[key] ? "bg-indigo-600" : "bg-gray-300 dark:bg-gray-700"}`}
                          >
                            <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${exportSettings.screenshot[key] ? "left-[18px]" : "left-0.5"}`} />
                          </button>
                        </div>
                      ))}
                      {/* Background */}
                      <div className="flex items-center justify-between">
                        <span className="text-gray-500 dark:text-gray-400">Background</span>
                        <div className="flex gap-1">
                          {(["white", "black", "transparent"] as const).map((bg) => (
                            <button
                              key={bg}
                              onClick={() => setExportSettings((s) => ({ ...s, screenshot: { ...s.screenshot, background: bg } }))}
                              className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                                exportSettings.screenshot.background === bg
                                  ? "bg-indigo-600 border-indigo-500 text-white"
                                  : "bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                              }`}
                            >
                              {bg === "transparent" ? "None" : bg[0].toUpperCase() + bg.slice(1)}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-gray-200 dark:border-gray-800" />

                  {/* ── GIF ── */}
                  <div>
                    <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">GIF Export</p>
                    <div className="space-y-2">
                      {/* Factor */}
                      <div className="flex items-center gap-2">
                        <span className="w-24 text-gray-500 dark:text-gray-400 flex-shrink-0">Factor</span>
                        <input
                          type="range" min={1} max={3} step={1}
                          value={exportSettings.gif.factor}
                          onChange={(e) => setExportSettings((s) => ({ ...s, gif: { ...s.gif, factor: Number(e.target.value) } }))}
                          className="flex-1 accent-indigo-500 h-1"
                        />
                        <span className="w-5 text-right text-gray-700 dark:text-gray-300 tabular-nums">{exportSettings.gif.factor}×</span>
                      </div>
                      {/* Max frames */}
                      <div className="flex items-center gap-2">
                        <span className="w-24 text-gray-500 dark:text-gray-400 flex-shrink-0">Max frames</span>
                        <input
                          type="range" min={10} max={120} step={10}
                          value={exportSettings.gif.maxFrames}
                          onChange={(e) => setExportSettings((s) => ({ ...s, gif: { ...s.gif, maxFrames: Number(e.target.value) } }))}
                          className="flex-1 accent-indigo-500 h-1"
                        />
                        <span className="w-8 text-right text-gray-700 dark:text-gray-300 tabular-nums">{exportSettings.gif.maxFrames}</span>
                      </div>
                      {/* Frame delay */}
                      <div className="flex items-center gap-2">
                        <span className="w-24 text-gray-500 dark:text-gray-400 flex-shrink-0">Frame delay</span>
                        <input
                          type="range" min={40} max={200} step={10}
                          value={exportSettings.gif.frameDelay}
                          onChange={(e) => setExportSettings((s) => ({ ...s, gif: { ...s.gif, frameDelay: Number(e.target.value) } }))}
                          className="flex-1 accent-indigo-500 h-1"
                        />
                        <span className="w-8 text-right text-gray-700 dark:text-gray-300 tabular-nums">{exportSettings.gif.frameDelay}ms</span>
                      </div>
                      {/* Booleans */}
                      {(["antialias", "trim"] as const).map((key) => (
                        <div key={key} className="flex items-center justify-between">
                          <span className="text-gray-500 dark:text-gray-400 capitalize">{key}</span>
                          <button
                            onClick={() => setExportSettings((s) => ({ ...s, gif: { ...s.gif, [key]: !s.gif[key as keyof typeof s.gif] } }))}
                            className={`w-8 h-4 rounded-full transition-colors relative flex-shrink-0 ${exportSettings.gif[key as keyof typeof exportSettings.gif] ? "bg-indigo-600" : "bg-gray-300 dark:bg-gray-700"}`}
                          >
                            <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${exportSettings.gif[key as keyof typeof exportSettings.gif] ? "left-[18px]" : "left-0.5"}`} />
                          </button>
                        </div>
                      ))}
                      {/* Background */}
                      <div className="flex items-center justify-between">
                        <span className="text-gray-500 dark:text-gray-400">Background</span>
                        <div className="flex gap-1">
                          {(["white", "black", "transparent"] as const).map((bg) => (
                            <button
                              key={bg}
                              onClick={() => setExportSettings((s) => ({ ...s, gif: { ...s.gif, background: bg } }))}
                              className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                                exportSettings.gif.background === bg
                                  ? "bg-indigo-600 border-indigo-500 text-white"
                                  : "bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                              }`}
                            >
                              {bg === "transparent" ? "None" : bg[0].toUpperCase() + bg.slice(1)}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Scrubber */}
      {(() => {
        const maxFrame = Math.max((totalFrames ?? 1) - 1, 0);
        const clampedFrame = Math.min(frame, maxFrame);
        const pct = maxFrame > 0 ? (clampedFrame / maxFrame) * 100 : 0;
        const disabled = !ready || !totalFrames || totalFrames <= 1 || gifGenerating;
        return (
          <div className={`flex items-center gap-3 ${disabled ? "opacity-40 pointer-events-none" : ""}`}>
            {/* Custom track */}
            <div className="relative flex-1 h-5 flex items-center group">
              {/* Background track */}
              <div className="absolute inset-x-0 h-1 rounded-full bg-gray-200 dark:bg-gray-800" />
              {/* Filled portion */}
              <div
                className="absolute left-0 h-1 rounded-full bg-indigo-600/80"
                style={{ width: `${pct}%` }}
              />
              {/* Thumb */}
              <div
                className="absolute w-3 h-3 rounded-full bg-indigo-400 border border-indigo-300/40 shadow shadow-indigo-900/60 transition-transform duration-75 group-hover:scale-125"
                style={{ left: `calc(${pct}% - 6px)` }}
              />
              {/* Invisible native input for interaction */}
              <input
                type="range"
                min={0}
                max={maxFrame}
                step={1}
                value={clampedFrame}
                onChange={(e) => handleSeek(Number(e.currentTarget.value))}
                disabled={disabled}
                className="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
              />
            </div>
            {/* Frame counter */}
            <span className="text-[10px] font-mono text-gray-500 tabular-nums whitespace-nowrap flex-shrink-0">
              {clampedFrame} / {maxFrame}
            </span>
          </div>
        );
      })()}
    </div>
  );
}
