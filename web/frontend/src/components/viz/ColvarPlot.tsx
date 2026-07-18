"use client";

import { useEffect, useState } from "react";
import { getColvar } from "@/lib/api";
import { RefreshCw } from "lucide-react";
import dynamic from "next/dynamic";
import { useTheme } from "@/lib/theme";
import { PLOT_COLORS, PLOT_CONFIG, plotLayout } from "@/lib/plotTheme";
const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

interface Props {
  sessionId: string;
}

export default function ColvarPlot({ sessionId }: Props) {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const [data, setData] = useState<Record<string, number[]> | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    getColvar(sessionId, "COLVAR", 3000)
      .then((r) => { if (r.available) setData(r.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(load, [sessionId]);

  if (!data) {
    return (
      <div className="p-3 text-center text-xs text-gray-400">
        <p>CV Time Series</p>
        <p className="mt-1">Available after PLUMED writes COLVAR</p>
        <button onClick={load} className="mt-2 text-blue-500 hover:underline flex items-center gap-1 mx-auto">
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>
    );
  }

  const timeKey = "time";
  const xData = data[timeKey] ?? [];
  const cvKeys = Object.keys(data).filter((k) => k !== timeKey && k !== "metad.bias");

  const traces: Plotly.Data[] = cvKeys.map((k, index) => ({
    type: "scatter",
    mode: "lines",
    x: xData,
    y: data[k],
    name: k,
    line: { width: 1.8, color: PLOT_COLORS[index % PLOT_COLORS.length] },
  }));

  return (
    <div>
      <div className="flex items-center justify-between px-2 pt-2">
        <p className="text-xs font-medium">Collective Variables</p>
        <button onClick={load} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      <Plot
        data={traces}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        layout={plotLayout(isDark, {
          xaxis: { title: "Time (ps)" as any },
          showlegend: true,
          legend: { font: { size: 10 }, orientation: "h", y: 1.08 },
          margin: { t: 10, l: 50, r: 10, b: 40 },
          height: 220,
        })}
        config={PLOT_CONFIG}
        style={{ width: "100%" }}
      />
    </div>
  );
}
