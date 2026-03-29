import type { SSEEvent } from "@/lib/types";
import { getToken } from "./auth";

export type AgentType = "paper" | "analysis" | "cv";

/**
 * Stream a specialist agent's SSE output.
 * Uses the same event format as the main chat stream so the same
 * rendering components (ToolCallCard, MessageBubble blocks) work unchanged.
 */
export async function* streamAgent(
  sessionId: string,
  agentType: AgentType,
  input: string,
  signal?: AbortSignal
): AsyncGenerator<SSEEvent> {
  const url = `/api/agents/${sessionId}/${agentType}/run?input=${encodeURIComponent(input)}`;
  const token = getToken();
  const res = await fetch(url, {
    signal,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok || !res.body) {
    throw new Error(`Agent request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (line.startsWith("data: ")) {
          try {
            yield JSON.parse(line.slice(6)) as SSEEvent;
          } catch {
            /* skip malformed chunk */
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
