"use client";

import { useEffect, useRef, useState } from "react";
import {
  X, Play, StopCircle, ChevronDown, ChevronRight, Loader2,
  Search, FileText, Download, Brain, Database, Save, Settings,
  PenTool, FolderOpen, BarChart3, Mountain, Zap, Map, Microscope,
  Dna, RefreshCw, Ruler, TriangleRight, Wrench,
} from "lucide-react";
import { streamAgent, type AgentType } from "@/lib/agentStream";
import { fetchPdb, getFileContent } from "@/lib/api";
import type { SSEEvent, ToolCallBlock, ThinkingBlock, TextBlock, ErrorBlock } from "@/lib/types";

// ── Types ──────────────────────────────────────────────────────────────

type AgentBlock =
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string; collapsed: boolean }
  | { kind: "tool_call"; tool_use_id: string; tool_name: string; input: Record<string, unknown>; result?: string; status: "pending" | "done" | "error" }
  | { kind: "error"; content: string };

// ── Block renderers ────────────────────────────────────────────────────

function TextRenderer({ block }: { block: { kind: "text"; content: string } }) {
  return (
    <div className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed">
      {block.content}
    </div>
  );
}

function ThinkingRenderer({ block }: { block: { kind: "thinking"; content: string; collapsed: boolean } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-purple-200/60 dark:border-purple-800/40 bg-purple-50/40 dark:bg-purple-950/20 overflow-hidden text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 text-purple-600 dark:text-purple-400 hover:text-purple-500 dark:hover:text-purple-300 transition-colors"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="font-medium">Thinking</span>
      </button>
      {open && (
        <pre className="px-3 pb-3 text-purple-500/70 dark:text-purple-300/70 whitespace-pre-wrap max-h-48 overflow-y-auto font-mono text-[10px]">
          {block.content}
        </pre>
      )}
    </div>
  );
}

const TOOL_ICONS: Record<string, React.ReactNode> = {
  search_papers: <Search size={12} />,
  fetch_arxiv_paper: <FileText size={12} />,
  download_and_read_paper: <Download size={12} />,
  extract_md_settings_from_paper: <Brain size={12} />,
  search_rcsb_pdb: <Database size={12} />,
  download_pdb_to_session: <Save size={12} />,
  update_session_config: <Settings size={12} />,
  write_plumed_dat: <PenTool size={12} />,
  list_simulation_files: <FolderOpen size={12} />,
  read_colvar_stats: <BarChart3 size={12} />,
  read_hills_stats: <Mountain size={12} />,
  read_energy_stats: <Zap size={12} />,
  read_log_progress: <FileText size={12} />,
  read_fes_summary: <Map size={12} />,
  list_structure_files: <FolderOpen size={12} />,
  read_atom_list: <Microscope size={12} />,
  read_residue_list: <Dna size={12} />,
  generate_torsion_cv: <RefreshCw size={12} />,
  generate_distance_cv: <Ruler size={12} />,
  generate_rmsd_cv: <TriangleRight size={12} />,
  generate_metadynamics_bias: <Mountain size={12} />,
};

function ToolCallRenderer({
  block,
}: {
  block: { kind: "tool_call"; tool_use_id: string; tool_name: string; input: Record<string, unknown>; result?: string; status: "pending" | "done" | "error" };
}) {
  const [open, setOpen] = useState(false);
  const icon = TOOL_ICONS[block.tool_name] ?? <Wrench size={12} />;
  const statusIcon =
    block.status === "pending" ? <Loader2 size={11} className="animate-spin text-blue-500 dark:text-blue-400" /> :
    block.status === "done"    ? <span className="text-emerald-500 dark:text-emerald-400 text-[10px]">✓</span> :
                                  <span className="text-red-500 dark:text-red-400 text-[10px]">✗</span>;

  return (
    <div className="rounded-lg border border-gray-200/60 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 overflow-hidden text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 hover:bg-gray-100/60 dark:hover:bg-gray-800/60 transition-colors text-left"
      >
        {open ? <ChevronDown size={11} className="text-gray-400 dark:text-gray-500" /> : <ChevronRight size={11} className="text-gray-400 dark:text-gray-500" />}
        <span className="text-gray-500 dark:text-gray-400">{icon}</span>
        <span className="font-mono text-gray-700 dark:text-gray-300 flex-1">{block.tool_name}</span>
        {statusIcon}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          <div>
            <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase mb-1">Input</p>
            <pre className="text-[10px] text-gray-500 dark:text-gray-400 whitespace-pre-wrap bg-gray-100/60 dark:bg-gray-900/60 rounded p-2 max-h-32 overflow-y-auto">
              {JSON.stringify(block.input, null, 2)}
            </pre>
          </div>
          {block.result && (
            <div>
              <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase mb-1">Output</p>
              <pre className="text-[10px] text-gray-700 dark:text-gray-300 whitespace-pre-wrap bg-gray-100/60 dark:bg-gray-900/60 rounded p-2 max-h-48 overflow-y-auto">
                {block.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Agent config ───────────────────────────────────────────────────────

interface AgentConfig {
  title: string;
  description: string;
  inputLabel: string;
  inputPlaceholder: string;
  defaultInput?: string;
  accent: string;
}

const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
  paper: {
    title: "Molecule Search Agent",
    description: "Finds PDB structures from RCSB and downloads them, or extracts GROMACS + PLUMED settings from a paper.",
    inputLabel: "PDB search, arXiv ID, or paper query",
    inputPlaceholder: "e.g. 'ubiquitin human'  or  2301.12345  or  'chignolin folding metadynamics'",
    accent: "blue",
  },
  analysis: {
    title: "Results Analyzer",
    description: "Reads COLVAR, HILLS, energy files, and md.log — assesses convergence and gives recommendations.",
    inputLabel: "Analysis focus (optional)",
    inputPlaceholder: "e.g. 'Focus on convergence of phi/psi' or leave blank for full analysis",
    defaultInput: "Analyze the simulation results and assess convergence.",
    accent: "emerald",
  },
  cv: {
    title: "CV Suggester",
    description: "Reads your structure file and suggests appropriate collective variables for metadynamics.",
    inputLabel: "Simulation goal",
    inputPlaceholder: "e.g. 'Phi/psi for alanine dipeptide' or 'Folding of a beta hairpin'",
    accent: "indigo",
  },
};

// ── Main modal ─────────────────────────────────────────────────────────

interface Props {
  sessionId: string;
  agentType: AgentType;
  onClose: () => void;
  onPdbLoaded?: (molecule: { content: string; name: string }) => void;
}

const PDB_ID_RE = /^[0-9A-Za-z]{4}$/;

export default function AgentModal({ sessionId, agentType, onClose, onPdbLoaded }: Props) {
  const config = AGENT_CONFIGS[agentType];
  const [input, setInput] = useState(config.defaultInput ?? "");
  const [blocks, setBlocks] = useState<AgentBlock[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const accentBorder = {
    blue: "border-blue-200/60 dark:border-blue-800/40",
    emerald: "border-emerald-200/60 dark:border-emerald-800/40",
    indigo: "border-indigo-200/60 dark:border-indigo-800/40",
  }[config.accent];

  const accentIcon = {
    blue: "bg-blue-100/60 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400",
    emerald: "bg-emerald-100/60 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400",
    indigo: "bg-indigo-100/60 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400",
  }[config.accent];

  const runFullAgent = async (query: string) => {
    abortRef.current = new AbortController();
    try {
      for await (const event of streamAgent(
        sessionId,
        agentType,
        query,
        abortRef.current.signal
      )) {
        setBlocks((prev) => applyEvent(prev, event));
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

        if (event.type === "agent_done" || event.type === "error") {
          setRunning(false);
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setBlocks((prev) => [...prev, { kind: "error", content: String(err) }]);
      }
      setRunning(false);
    }
  };

  const handleRun = async () => {
    if (running) return;
    setBlocks([]);
    setRunning(true);

    const query = input.trim() || config.defaultInput || "";

    // For the paper agent, try a direct PDB fetch first if input looks like a PDB ID
    if (agentType === "paper" && PDB_ID_RE.test(query)) {
      setBlocks([{
        kind: "tool_call",
        tool_use_id: "pdb-quick",
        tool_name: "download_pdb_to_session",
        input: { pdb_id: query.toUpperCase() },
        status: "pending",
      }]);
      try {
        const { filename } = await fetchPdb(sessionId, query);
        setBlocks((prev) => prev.map((b) =>
          b.kind === "tool_call" && b.tool_use_id === "pdb-quick"
            ? { ...b, status: "done" as const, result: `Downloaded ${filename}` }
            : b
        ));
        setBlocks((prev) => [...prev, { kind: "text", content: `Successfully downloaded ${filename} from RCSB PDB.` }]);
        if (onPdbLoaded) {
          try {
            const content = await getFileContent(sessionId, filename);
            onPdbLoaded({ content, name: filename });
          } catch { /* viewer load is best-effort */ }
        }
        setRunning(false);
        return;
      } catch {
        // PDB fetch failed — fall through to full agent
        setBlocks((prev) => prev.map((b) =>
          b.kind === "tool_call" && b.tool_use_id === "pdb-quick"
            ? { ...b, status: "error" as const, result: `Not found in RCSB — falling back to agent` }
            : b
        ));
      }
    }

    await runFullAgent(query);
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className={`bg-white dark:bg-gray-900 border ${accentBorder} rounded-2xl flex flex-col shadow-2xl`}
        style={{ width: "min(860px, 92vw)", height: "80vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div className={`p-2 rounded-lg ${accentIcon} flex-shrink-0`}>
            <AgentIcon type={agentType} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{config.title}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{config.description}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Input row */}
        <div className="flex gap-2 items-end px-5 py-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-500 mb-1">{config.inputLabel}</label>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !running) handleRun(); }}
              placeholder={config.inputPlaceholder}
              className="w-full border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {running ? (
            <button
              onClick={handleStop}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/50 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800/50 hover:bg-red-100 dark:hover:bg-red-800/50 transition-colors text-sm flex-shrink-0"
            >
              <StopCircle size={14} />
              Stop
            </button>
          ) : (
            <button
              onClick={handleRun}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors text-sm flex-shrink-0 font-medium"
            >
              <Play size={14} fill="currentColor" />
              Run
            </button>
          )}
        </div>

        {/* Output */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {blocks.length === 0 && !running && (
            <div className="h-full flex items-center justify-center text-gray-400 dark:text-gray-600 text-sm">
              Configure the input above and click Run to start the agent.
            </div>
          )}
          {running && blocks.length === 0 && (
            <div className="flex items-center gap-2 text-gray-500 text-sm">
              <Loader2 size={14} className="animate-spin" />
              Starting agent…
            </div>
          )}
          {blocks.map((block, i) => (
            <div key={i}>
              {block.kind === "text" && <TextRenderer block={block} />}
              {block.kind === "thinking" && <ThinkingRenderer block={block} />}
              {block.kind === "tool_call" && <ToolCallRenderer block={block} />}
              {block.kind === "error" && (
                <div className="text-xs text-red-600 dark:text-red-400 bg-red-50/60 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">
                  Error: {block.content}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

// ── SSE event → block reducer ──────────────────────────────────────────

function applyEvent(prev: AgentBlock[], event: SSEEvent): AgentBlock[] {
  const blocks = [...prev];

  switch (event.type) {
    case "text_delta": {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "text") {
        blocks[blocks.length - 1] = { kind: "text", content: last.content + event.text };
      } else {
        blocks.push({ kind: "text", content: event.text });
      }
      return blocks;
    }
    case "thinking":
      blocks.push({ kind: "thinking", content: event.thinking, collapsed: true });
      return blocks;

    case "tool_start":
      blocks.push({
        kind: "tool_call",
        tool_use_id: event.tool_use_id,
        tool_name: event.tool_name,
        input: event.tool_input,
        status: "pending",
      });
      return blocks;

    case "tool_result": {
      return blocks.map((b) =>
        b.kind === "tool_call" && b.tool_use_id === event.tool_use_id
          ? { ...b, status: "done" as const, result: (event.result as { output?: string })?.output ?? JSON.stringify(event.result) }
          : b
      );
    }
    case "agent_done":
      return blocks;

    case "error":
      blocks.push({ kind: "error", content: event.message });
      return blocks;

    default:
      return blocks;
  }
}

// ── Agent icon ─────────────────────────────────────────────────────────

function AgentIcon({ type }: { type: AgentType }) {
  if (type === "paper") return <FileText size={16} />;
  if (type === "analysis") return <Microscope size={16} />;
  return <Brain size={16} />;
}
