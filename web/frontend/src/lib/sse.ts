import type { AssistantActionInvocation, SSEEvent } from "./types";
import { getToken } from "./auth";

/**
 * Core SSE reader: POSTs {message} to `url` and yields parsed events.
 * fetch() + ReadableStream supports long POST bodies (vs EventSource's GET-only).
 */
async function* streamSSE(
  url: string,
  message: string,
  signal: AbortSignal,
  action?: AssistantActionInvocation,
  contextSessionId?: string
): AsyncGenerator<SSEEvent> {
  const token = getToken();
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      message,
      ...(action ? { action } : {}),
      ...(contextSessionId ? { context_session_id: contextSessionId } : {}),
    }),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  if (!response.body) throw new Error("No response body");

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
        if (dataLine) {
          try {
            yield JSON.parse(dataLine.slice(6)) as SSEEvent;
          } catch {
            // malformed chunk — skip
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Per-simulation agent stream (legacy MDAgent path). */
export function streamChat(sessionId: string, message: string, signal: AbortSignal) {
  return streamSSE(`/api/sessions/${sessionId}/stream`, message, signal);
}

/** Project-level (or general, when projectId is null) assistant stream. */
export function streamAssistant(
  projectId: string | null,
  message: string,
  signal: AbortSignal,
  action?: AssistantActionInvocation,
  contextSessionId?: string
) {
  const url = projectId ? `/api/projects/${projectId}/stream` : `/api/assistant/stream`;
  return streamSSE(url, message, signal, action, contextSessionId);
}
