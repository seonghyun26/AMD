"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { suppressNglDeprecationWarnings } from "@/lib/ngl";

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    NGL: any;
  }
}

interface Props {
  fileContent: string;
  fileName: string;
  height?: number;
}

/**
 * Minimal NGL structure viewer — stick representation only.
 * Supports zoom (scroll), rotate (drag), translate (right-click).
 * No rep toggles, no screenshot, no stats overlay.
 */
export default function MiniStructureViewer({ fileContent, fileName, height = 180 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stageRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(null);
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "pdb";
    let ro: ResizeObserver | null = null;

    const initViewer = () => {
      if (cancelled || !containerRef.current || !window.NGL) return;

      if (stageRef.current) {
        stageRef.current.dispose();
        stageRef.current = null;
      }
      containerRef.current.innerHTML = "";

      suppressNglDeprecationWarnings();
      const stage = new window.NGL.Stage(containerRef.current, { backgroundColor: "transparent" });
      stageRef.current = stage;

      ro = new ResizeObserver(() => stage.handleResize());
      ro.observe(containerRef.current);

      const blob = new Blob([fileContent], { type: "text/plain" });
      stage
        .loadFile(blob, { ext, defaultRepresentation: false, name: fileName })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((component: any) => {
          if (cancelled) return;
          component.addRepresentation("licorice", { colorScheme: "element" });
          component.autoView(400);
          setReady(true);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(String(err));
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
          loadHandler = () => { existing.dataset.loaded = "true"; initViewer(); };
          existing.addEventListener("load", loadHandler, { once: true });
        }
      } else {
        const script = document.createElement("script");
        scriptEl = script;
        script.id = "ngl-script";
        script.src = "https://cdn.jsdelivr.net/npm/ngl/dist/ngl.js";
        script.async = true;
        loadHandler = () => { script.dataset.loaded = "true"; initViewer(); };
        script.addEventListener("load", loadHandler, { once: true });
        document.head.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
      if (scriptEl && loadHandler) scriptEl.removeEventListener("load", loadHandler);
      ro?.disconnect();
      if (stageRef.current) { stageRef.current.dispose(); stageRef.current = null; }
    };
  }, [fileContent, fileName]);

  return (
    <div
      className="relative rounded-lg overflow-hidden border border-gray-300/60 dark:border-gray-700/60 bg-white dark:bg-gray-900"
      style={{ height }}
    >
      {error ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-red-400 gap-1.5 p-3 z-10">
          <AlertCircle size={14} />
          <span className="text-[10px] text-center break-all">{error}</span>
        </div>
      ) : !ready ? (
        <div className="absolute inset-0 flex items-center justify-center text-gray-500 z-10">
          <Loader2 size={14} className="animate-spin mr-1.5" />
          <span className="text-[10px]">Loading…</span>
        </div>
      ) : null}
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
