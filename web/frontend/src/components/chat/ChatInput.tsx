"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Bot, StopCircle, FlaskConical } from "lucide-react";
import { useSessionStore } from "@/store/sessionStore";
import { streamAssistant } from "@/lib/sse";
import type { AssistantActionInvocation } from "@/lib/types";

interface Props {
  /** null = general assistant (home); otherwise this project's assistant. */
  projectId: string | null;
  /** Currently open simulation; used only as trusted context for state queries. */
  contextSessionId?: string | null;
  /** When set to a non-empty string, auto-sends that message once. */
  autoSend?: string;
  onAutoSendComplete?: () => void;
  /** The selected workspace tab determines the assistant shortcuts shown above the composer. */
  workspaceTab?: string;
}

type ContextAction = {
  label: string;
  title: string;
  prompt: (nickname: string) => string;
  action?: AssistantActionInvocation["name"];
};

const TAB_CONTEXT_ACTIONS: Record<string, ContextAction[]> = {
  progress: [
    {
      label: "Start simulation",
      title: "Start simulation",
      action: "start_simulation",
      prompt: (nickname) =>
        `Check the configuration and available storage for the "${nickname}" simulation, then start it only if there are no blocking problems.`,
    },
    {
      label: "Analyze results",
      title: "Analyze results",
      action: "analyze_simulation",
      prompt: (nickname) =>
        `Analyze the results of the "${nickname}" simulation: summarize the trajectory, energies and any collective variables, assess stability and convergence, and flag anything notable or wrong.`,
    },
  ],
  molecule: [
    {
      label: "Inspect system",
      title: "Find a molecular system",
      action: "inspect_molecular_system",
      prompt: (nickname) =>
        `Help me inspect the molecular system for the "${nickname}" simulation. List the structure/topology input files already present, identify what system is set up, and suggest suitable PDB structures (with IDs) if something is missing.`,
    },
  ],
  gromacs: [
    {
      label: "Review setup",
      title: "Review initial configuration",
      action: "review_initial_configuration",
      prompt: (nickname) =>
        `Review the GROMACS parameters configured for the "${nickname}" simulation (see its config.yaml / .mdp) and suggest sensible values or flag anything unusual for this system — thermostat, timestep, cutoffs, electrostatics, constraints and run length.`,
    },
  ],
  method: [
    {
      label: "Research CVs",
      title: "Research CV publications",
      action: "research_cv_publications",
      prompt: (nickname) =>
        `Find relevant publications for collective variables (CVs) for the "${nickname}" system, then recommend CVs for its enhanced-sampling method with PLUMED-style definitions and evidence-based rationale.`,
    },
  ],
  files: [
    {
      label: "Inspect files",
      title: "Inspect simulation files",
      prompt: (nickname) =>
        `Inspect the local files for the "${nickname}" simulation. Summarize which inputs and outputs are present, what each important file is for, and flag only missing files that matter for the current simulation state.`,
    },
  ],
};

/** Detect a trailing `@query` token immediately before the caret (used for the
 *  simulation-name mention popup). Returns the query text and the `@` offset. */
function mentionAt(text: string, caret: number): { query: string; start: number } | null {
  const upto = text.slice(0, caret);
  // `@` must be at the start or preceded by whitespace; query = word-ish chars.
  const m = upto.match(/(?:^|\s)@([\w.()/-]*)$/);
  if (!m) return null;
  return { query: m[1], start: caret - m[1].length - 1 };
}

function GradientSendIcon({ size = 19 }: { size?: number }) {
  const gradientId = useId().replace(/:/g, "");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--amd-arc-cyan)" />
          <stop offset="0.42" stopColor="var(--amd-brand-primary)" />
          <stop offset="0.72" stopColor="var(--amd-arc-indigo)" />
          <stop offset="1" stopColor="var(--amd-arc-violet)" />
        </linearGradient>
      </defs>
      <path
        d="m22 2-7 20-4-9-9-4Z"
        stroke={`url(#${gradientId})`}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M22 2 11 13"
        stroke={`url(#${gradientId})`}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function ChatInput({
  projectId,
  contextSessionId,
  autoSend,
  onAutoSendComplete,
  workspaceTab = "progress",
}: Props) {
  const [value, setValue] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Tracks the current scope so an in-flight stream can tell if the user
  // switched projects (its appends/persist would otherwise corrupt the other
  // project's conversation, which shares the single global `messages` array).
  const projectIdRef = useRef(projectId);
  useEffect(() => {
    projectIdRef.current = projectId;
    // Abort any stream in flight when the scope changes (or on unmount).
    return () => abortRef.current?.abort();
  }, [projectId]);
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const sessions = useSessionStore((s) => s.sessions);
  const pendingPrompt = useSessionStore((s) => s.pendingPrompt);
  const {
    addUserMessage,
    appendSSEEvent,
    consumePendingPrompt,
    fetchSessions,
    fetchSimulations,
    persistAssistant,
    requestAssistant,
  } = useSessionStore();

  // @-mention state — only active inside a project (simulations belong to one).
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [hi, setHi] = useState(0);

  const matches = useMemo(() => {
    if (!mentionOpen || !projectId) return [];
    const q = mentionQuery.toLowerCase();
    return sessions
      .filter((s) => (s.nickname || "").toLowerCase().includes(q))
      .slice(0, 8);
  }, [mentionOpen, projectId, mentionQuery, sessions]);
  const contextActions = contextSessionId ? TAB_CONTEXT_ACTIONS[workspaceTab] ?? [] : [];

  useEffect(() => {
    if (hi > matches.length - 1) setHi(0);
  }, [matches.length, hi]);

  const doSend = async (text: string, title?: string, action?: AssistantActionInvocation) => {
    if (!text.trim() || isStreaming) return;
    const sendScope = projectId; // scope this send belongs to
    setValue("");
    setMentionOpen(false);
    addUserMessage(text, title);
    abortRef.current = new AbortController();
    const normalizedText = text.toLowerCase();
    const mentionedSession = [...sessions]
      .filter((session) => session.nickname && normalizedText.includes(`@${session.nickname.toLowerCase()}`))
      .sort((a, b) => b.nickname.length - a.nickname.length)[0];
    const resolvedContextSessionId =
      action?.session_id || mentionedSession?.session_id || contextSessionId || undefined;
    try {
      for await (const event of streamAssistant(
        sendScope,
        text,
        abortRef.current.signal,
        action,
        resolvedContextSessionId,
      )) {
        if (projectIdRef.current !== sendScope) return; // switched away — don't touch the new scope
        appendSSEEvent(event);
        if (event.type === "tool_result" && event.tool_name === "create_simulation") {
          if (sendScope) await fetchSimulations(sendScope);
          else await fetchSessions();
        }
      }
    } catch (err) {
      if (projectIdRef.current !== sendScope) return;
      if ((err as Error).name !== "AbortError") {
        appendSSEEvent({ type: "error", message: String(err) });
      } else {
        appendSSEEvent({ type: "agent_done", final_text: "" });
      }
    }
    // Only persist if we're still in the same conversation we sent from.
    if (projectIdRef.current === sendScope) persistAssistant(sendScope);
  };

  const handleSend = () => doSend(value);
  const handleStop = () => abortRef.current?.abort();
  const handleContextAction = (action: ContextAction) => {
    if (!contextSessionId || isStreaming) return;
    const nickname = sessions.find((session) => session.session_id === contextSessionId)?.nickname || "selected";
    requestAssistant(
      action.prompt(nickname),
      action.title,
      action.action ? { name: action.action, session_id: contextSessionId } : undefined,
    );
  };

  const refreshMention = (text: string, caret: number) => {
    if (!projectId) { setMentionOpen(false); return; }
    const m = mentionAt(text, caret);
    if (m) { setMentionQuery(m.query); setMentionOpen(true); }
    else setMentionOpen(false);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setValue(text);
    refreshMention(text, e.target.selectionStart ?? text.length);
  };

  const insertMention = (nickname: string) => {
    const el = taRef.current;
    const caret = el?.selectionStart ?? value.length;
    const m = mentionAt(value, caret);
    if (!m) return;
    const before = value.slice(0, m.start);
    const after = value.slice(caret);
    const inserted = `@${nickname} `;
    const next = before + inserted + after;
    setValue(next);
    setMentionOpen(false);
    const pos = (before + inserted).length;
    requestAnimationFrame(() => {
      const t = taRef.current;
      if (t) { t.focus(); t.setSelectionRange(pos, pos); }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen && matches.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => (h + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => (h - 1 + matches.length) % matches.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertMention(matches[hi]?.nickname || ""); return; }
      if (e.key === "Escape") { e.preventDefault(); setMentionOpen(false); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  useEffect(() => {
    if (autoSend && !isStreaming) {
      doSend(autoSend);
      onAutoSendComplete?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend]);

  // A workspace shortcut ("Analyze", "Suggest CVs", …) queued a prompt — send it.
  useEffect(() => {
    if (!pendingPrompt) return;
    consumePendingPrompt();
    if (!isStreaming) doSend(pendingPrompt.text, pendingPrompt.title, pendingPrompt.action);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrompt]);

  return (
    <div className="p-3 bg-white/50 dark:bg-gray-900/50 flex-shrink-0">
      {contextActions.length > 0 && (
        <div className="mb-3 flex items-center gap-2 overflow-x-auto">
          {contextActions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => handleContextAction(action)}
              disabled={isStreaming}
              className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-indigo-200/70 bg-gradient-to-r from-cyan-50 via-blue-50 to-indigo-50 px-2.5 py-1.5 text-[11px] font-medium text-indigo-700 transition-colors hover:from-cyan-100 hover:via-blue-100 hover:to-indigo-100 disabled:cursor-not-allowed disabled:opacity-45 dark:border-indigo-500/30 dark:from-cyan-950/50 dark:via-blue-950/50 dark:to-indigo-950/50 dark:text-indigo-200 dark:hover:from-cyan-950/70 dark:hover:via-blue-950/70 dark:hover:to-indigo-950/70"
            >
              <Bot size={12} />
              {action.label}
            </button>
          ))}
        </div>
      )}
      <div className="relative">
        {/* @-mention dropdown — simulations in this project */}
        {mentionOpen && matches.length > 0 && (
          <div className="amd-mention-list-enter absolute bottom-full left-0 mb-2 w-72 max-w-full max-h-60 overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl z-50 py-1">
            <p className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">Simulations</p>
            {matches.map((s, i) => (
              <button
                key={s.session_id}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); insertMention(s.nickname); }}
                onMouseEnter={() => setHi(i)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
                  i === hi ? "bg-blue-50 dark:bg-blue-950/50" : "hover:bg-gray-50 dark:hover:bg-gray-700/50"
                }`}
              >
                <FlaskConical size={13} className="flex-shrink-0 text-blue-500/70" />
                <span className="text-sm text-gray-800 dark:text-gray-200 truncate flex-1">{s.nickname}</span>
                <span className="text-[10px] font-mono text-gray-400 dark:text-gray-500 flex-shrink-0">
                  {s.session_id.slice(0, 6)}
                </span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onClick={(e) => refreshMention(value, (e.target as HTMLTextAreaElement).selectionStart ?? value.length)}
          placeholder={projectId ? "Ask about this project's simulations…  (@ to mention one)" : "Ask the assistant…"}
          rows={3}
          className="amd-highlight-field w-full resize-none rounded-xl py-2 pl-3 pr-12 text-sm text-gray-900 dark:text-gray-100 focus:outline-none placeholder-gray-400 dark:placeholder-gray-500"
        />
        {isStreaming ? (
          <button
            onClick={handleStop}
            className="absolute right-2.5 top-1/2 -mt-1 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg border-0 bg-transparent text-red-500 transition-[filter,opacity] hover:brightness-110 dark:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
            title="Stop"
            aria-label="Stop response"
          >
            <StopCircle size={18} />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!value.trim()}
            className="absolute right-2.5 top-1/2 -mt-1 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg border-0 bg-transparent transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
            title="Send (Enter)"
            aria-label="Send message"
          >
            <GradientSendIcon />
          </button>
        )}
      </div>
      <p className="text-center text-xs text-gray-400 dark:text-gray-600 mt-1.5">
        Enter to send · Shift+Enter for newline
      </p>
    </div>
  );
}
