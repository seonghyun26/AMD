// SSE event discriminated union — mirrors web/backend SSE event protocol
export type SSEEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "tool_start";
      tool_use_id: string;
      tool_name: string;
      tool_input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      tool_name: string;
      result: Record<string, unknown>;
    }
  | {
      type: "sim_progress";
      step: number;
      total_steps: number;
      ns_per_day: number;
      time_ps: number;
    }
  | { type: "agent_done"; final_text: string }
  | { type: "error"; message: string };

export type MessageRole = "user" | "assistant";

export type TextBlock = { kind: "text"; content: string };
export type ThinkingBlock = { kind: "thinking"; content: string; collapsed: boolean };
export type ToolCallBlock = {
  kind: "tool_call";
  tool_use_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
  status: "pending" | "done" | "error";
};

export type ErrorBlock = { kind: "error"; content: string };

export type MessageBlock = TextBlock | ThinkingBlock | ToolCallBlock | ErrorBlock;

export interface ChatMessage {
  id: string;
  role: MessageRole;
  blocks: MessageBlock[];
  timestamp: number;
  finalized?: boolean;
}

export interface SimProgress {
  step: number;
  totalSteps: number;
  nsPerDay: number;
  timePs: number;
  lastUpdated: number;
}

export interface SessionConfig {
  method: string;
  system: string;
  gromacs: string;
  plumed_cvs: string;
  workDir: string;
}

export interface ConfigOptions {
  methods: string[];
  systems: string[];
  gromacs: string[];
  plumed_cvs: string[];
}

export interface Project {
  project_id: string;
  name: string;
  username: string;
  description?: string;
  molecule?: string;
  system?: string;
  goal?: string;
  status?: string;
  simulation_count?: number;
  created_at?: string;
  updated_at?: string;
}
