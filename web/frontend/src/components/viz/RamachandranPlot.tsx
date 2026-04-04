"use client";

import { useEffect, useState } from "react";
import { getRamachandranImageUrl } from "@/lib/api";
import { RefreshCw } from "lucide-react";

interface Props {
  sessionId: string;
  height?: number;
}

export default function RamachandranPlot({ sessionId, height = 260 }: Props) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = (force: boolean) => {
    setStatus("loading");
    setError(null);
    const cacheBust = force ? Date.now() : 0;
    fetch(getRamachandranImageUrl(sessionId, force, cacheBust))
      .then(async (res) => {
        if (res.ok) {
          setImgSrc(getRamachandranImageUrl(sessionId, false, cacheBust));
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

  return (
    <div>
      <div className="flex items-center justify-between px-2 pt-2">
        <p className="text-xs font-medium">Ramachandran Plot</p>
        <button onClick={() => load(true)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <RefreshCw size={12} className={status === "loading" ? "animate-spin" : ""} />
        </button>
      </div>
      {status === "loading" && (
        <div className="flex items-center justify-center" style={{ height }}>
          <RefreshCw size={16} className="animate-spin text-gray-500" />
        </div>
      )}
      {status === "error" && (
        <div className="flex flex-col items-center justify-center gap-1 px-3 text-center" style={{ height }}>
          <p className="text-xs text-red-400">{error}</p>
          <button onClick={() => load(true)} className="text-xs text-blue-400 hover:underline">Retry</button>
        </div>
      )}
      {status === "ok" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imgSrc ?? ""}
          alt="Ramachandran plot"
          style={{ width: "100%", height }}
          className="object-contain"
        />
      )}
    </div>
  );
}
