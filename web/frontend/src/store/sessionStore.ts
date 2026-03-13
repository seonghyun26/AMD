import { create } from "zustand";
import type {
  ChatMessage,
  MessageBlock,
  SimProgress,
  SessionConfig,
  SSEEvent,
  ToolCallBlock,
} from "@/lib/types";
import { listSessions } from "@/lib/api";
import { getUsername } from "@/lib/auth";

export interface SessionSummary {
  session_id: string;
  work_dir: string;
  nickname: string;
  selected_molecule?: string;
  run_status?: "standby" | "running" | "finished" | "failed" | "paused";
  started_at?: number;
  finished_at?: number;
  result_cards?: string[];
}

interface SessionState {
  sessionId: string | null;
  config: SessionConfig | null;
  messages: ChatMessage[];
  simProgress: SimProgress | null;
  isStreaming: boolean;
  sessions: SessionSummary[];
  sessionsLoading: boolean;

  // Actions
  setSession: (id: string, config: SessionConfig) => void;
  switchSession: (id: string, workDir: string) => void;
  fetchSessions: () => Promise<void>;
  addSession: (s: SessionSummary) => void;
  removeSession: (sessionId: string) => void;
  updateSessionNickname: (sessionId: string, nickname: string) => void;
  setSessionMolecule: (sessionId: string, molecule: string) => void;
  setSessionRunStatus: (sessionId: string, runStatus: SessionSummary["run_status"]) => void;
  setSessionResultCards: (sessionId: string, resultCards: string[]) => void;
  addUserMessage: (text: string) => void;
  appendSSEEvent: (event: SSEEvent) => void;
  updateProgress: (progress: SimProgress) => void;
  clearMessages: () => void;
}

function newAssistantMessage(): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    blocks: [],
    timestamp: Date.now(),
    finalized: false,
  };
}

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: null,
  config: null,
  messages: [],
  simProgress: null,
  isStreaming: false,
  sessions: [],
  sessionsLoading: true,

  setSession: (id, config) =>
    set({ sessionId: id, config, messages: [], simProgress: null }),

  switchSession: (id, workDir) =>
    set({ sessionId: id, config: { method: "", system: "", gromacs: "", plumed_cvs: "", workDir }, messages: [], simProgress: null, isStreaming: false }),

  fetchSessions: async () => {
    try {
      set({ sessionsLoading: true });
      const { sessions } = await listSessions(getUsername());
      set({ sessions, sessionsLoading: false });
    } catch {
      set({ sessionsLoading: false });
    }
  },

  addSession: (s) =>
    set((state) => ({
      sessions: [s, ...state.sessions.filter((x) => x.session_id !== s.session_id)],
    })),

  removeSession: (sessionId) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.session_id !== sessionId),
      sessionId: state.sessionId === sessionId ? null : state.sessionId,
    })),

  updateSessionNickname: (sessionId, nickname) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.session_id === sessionId ? { ...s, nickname } : s
      ),
    })),

  setSessionMolecule: (sessionId, molecule) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.session_id === sessionId ? { ...s, selected_molecule: molecule } : s
      ),
    })),

  setSessionRunStatus: (sessionId, runStatus) =>
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.session_id !== sessionId) return s;
        // "finished" is a terminal state — no further transitions
        if (s.run_status === "finished") return s;
        // "failed" can only transition to "running" (new simulation attempt)
        if (s.run_status === "failed" && runStatus !== "running") return s;
        // "paused" can transition to "running" (resume) or "standby" (terminate)
        if (s.run_status === "paused" && runStatus !== "running" && runStatus !== "standby") return s;
        return { ...s, run_status: runStatus };
      }),
    })),

  setSessionResultCards: (sessionId, resultCards) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.session_id === sessionId ? { ...s, result_cards: resultCards } : s
      ),
    })),

  addUserMessage: (text) =>
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: crypto.randomUUID(),
          role: "user",
          blocks: [{ kind: "text", content: text }],
          timestamp: Date.now(),
        },
      ],
      isStreaming: true,
    })),

  appendSSEEvent: (event) =>
    set((state) => {
      const messages = [...state.messages];

      const ensureAssistant = (): ChatMessage => {
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant" && !last.finalized) return last;
        const msg = newAssistantMessage();
        messages.push(msg);
        return msg;
      };

      switch (event.type) {
        case "text_delta": {
          const msg = ensureAssistant();
          const idx = messages.indexOf(msg);
          const blocks = [...msg.blocks];
          const lastBlock = blocks[blocks.length - 1];
          if (lastBlock && lastBlock.kind === "text") {
            blocks[blocks.length - 1] = {
              kind: "text",
              content: lastBlock.content + event.text,
            };
          } else {
            blocks.push({ kind: "text", content: event.text });
          }
          messages[idx] = { ...msg, blocks };
          return { messages, isStreaming: true };
        }

        case "thinking": {
          const msg = ensureAssistant();
          const idx = messages.indexOf(msg);
          const blocks = [
            ...msg.blocks,
            { kind: "thinking" as const, content: event.thinking, collapsed: true },
          ];
          messages[idx] = { ...msg, blocks };
          return { messages };
        }

        case "tool_start": {
          const msg = ensureAssistant();
          const idx = messages.indexOf(msg);
          const toolBlock: ToolCallBlock = {
            kind: "tool_call",
            tool_use_id: event.tool_use_id,
            tool_name: event.tool_name,
            input: event.tool_input,
            status: "pending",
          };
          messages[idx] = { ...msg, blocks: [...msg.blocks, toolBlock] };
          return { messages };
        }

        case "tool_result": {
          const updated: ChatMessage[] = messages.map((m) => ({
            ...m,
            blocks: m.blocks.map((b): MessageBlock => {
              if (b.kind === "tool_call" && b.tool_use_id === event.tool_use_id) {
                return { ...b, result: event.result, status: "done" };
              }
              return b;
            }),
          }));
          return { messages: updated };
        }

        case "sim_progress":
          return {
            simProgress: {
              step: event.step,
              totalSteps: event.total_steps,
              nsPerDay: event.ns_per_day,
              timePs: event.time_ps,
              lastUpdated: Date.now(),
            },
          };

        case "agent_done": {
          const last = messages[messages.length - 1];
          if (last && last.role === "assistant") {
            const idx = messages.length - 1;
            const blocks = [...last.blocks];
            const finalText = (event.final_text ?? "").trim();
            if (finalText) {
              const lastBlock = blocks[blocks.length - 1];
              if (lastBlock && lastBlock.kind === "text") {
                blocks[blocks.length - 1] = { kind: "text", content: `${lastBlock.content}\n${finalText}` };
              } else {
                blocks.push({ kind: "text", content: finalText });
              }
            }
            messages[idx] = { ...last, blocks, finalized: true };
          }
          return { messages, isStreaming: false };
        }

        case "error": {
          const msg = ensureAssistant();
          const idx = messages.indexOf(msg);
          messages[idx] = {
            ...msg,
            blocks: [...msg.blocks, { kind: "error" as const, content: event.message }],
            finalized: true,
          };
          return { messages, isStreaming: false };
        }

        default:
          return {};
      }
    }),

  updateProgress: (progress) => set({ simProgress: progress }),
  clearMessages: () => set({ messages: [] }),
}));
