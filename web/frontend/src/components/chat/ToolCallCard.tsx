"use client";

import { useState } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  Terminal,
} from "lucide-react";
import type { ToolCallBlock } from "@/lib/types";

const TOOL_ICONS: Record<string, string> = {
  run_grompp: "⚙️",
  run_mdrun: "▶️",
  wait_mdrun: "⏳",
  run_gmx_command: "🔬",
  generate_plumed_metadynamics: "📄",
  generate_plumed_umbrella: "📄",
  generate_plumed_steered: "📄",
  validate_plumed_input: "✅",
  analyze_hills: "📊",
  wandb_init_run: "📡",
  wandb_start_background_monitor: "📡",
  wandb_stop_monitor: "📡",
  generate_mdp_from_config: "⚙️",
  search_semantic_scholar: "🔍",
  fetch_arxiv_paper: "📰",
  read_file: "📂",
  list_files: "📂",
};

function StatusIcon({ status }: { status: ToolCallBlock["status"] }) {
  if (status === "pending") return <Loader2 size={14} className="animate-spin text-blue-500" />;
  if (status === "done") return <CheckCircle2 size={14} className="text-green-500" />;
  return <XCircle size={14} className="text-red-500" />;
}

export default function ToolCallCard({ block }: { block: ToolCallBlock }) {
  const [open, setOpen] = useState(false);
  const emoji = TOOL_ICONS[block.tool_name] ?? "🔧";

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className="my-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800/50 text-sm"
    >
      <Collapsible.Trigger className="flex items-center gap-2 p-2.5 w-full text-left cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors">
        <span className="text-base leading-none">{emoji}</span>
        <span className="font-mono text-xs text-gray-700 dark:text-gray-300 flex-1 min-w-0 truncate">{block.tool_name}</span>
        <StatusIcon status={block.status} />
        {open ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
      </Collapsible.Trigger>

      <Collapsible.Content>
        <div className="border-t border-gray-200 dark:border-gray-700 p-3 space-y-2">
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Input</p>
            <pre className="text-xs overflow-auto bg-gray-100 dark:bg-gray-900 rounded p-2 max-h-40 text-gray-700 dark:text-gray-300">
              {JSON.stringify(block.input, null, 2)}
            </pre>
          </div>
          {block.result !== undefined && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Result</p>
              <pre className="text-xs overflow-auto bg-gray-100 dark:bg-gray-900 rounded p-2 max-h-48 text-gray-700 dark:text-gray-300">
                {JSON.stringify(block.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
