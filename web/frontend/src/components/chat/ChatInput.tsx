"use client";

import { useEffect, useRef, useState } from "react";
import { Send, StopCircle } from "lucide-react";
import { useSessionStore } from "@/store/sessionStore";
import { streamChat } from "@/lib/sse";

interface Props {
  sessionId: string;
  /** When set to a non-empty string, auto-sends that message once. */
  autoSend?: string;
  onAutoSendComplete?: () => void;
}

export default function ChatInput({ sessionId, autoSend, onAutoSendComplete }: Props) {
  const [value, setValue] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const { addUserMessage, appendSSEEvent } = useSessionStore();

  const doSend = async (text: string) => {
    if (!text.trim() || isStreaming) return;
    setValue("");
    addUserMessage(text);

    abortRef.current = new AbortController();

    try {
      for await (const event of streamChat(sessionId, text, abortRef.current.signal)) {
        appendSSEEvent(event);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        appendSSEEvent({ type: "error", message: String(err) });
      } else {
        appendSSEEvent({ type: "agent_done", final_text: "" });
      }
    }
  };

  const handleSend = () => doSend(value);

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-send external message (e.g. from "Start MD" button)
  useEffect(() => {
    if (autoSend && !isStreaming) {
      doSend(autoSend);
      onAutoSendComplete?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend]);

  return (
    <div className="border-t border-gray-200 dark:border-gray-800 p-3 bg-white/50 dark:bg-gray-900/50 flex-shrink-0">
      <div className="flex gap-2 items-end">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe your simulation, ask about a paper, or give instructions…"
          rows={3}
          className="flex-1 resize-none border border-gray-300 dark:border-gray-700 rounded-xl px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-gray-500"
        />
        {isStreaming ? (
          <button
            onClick={handleStop}
            className="p-2.5 rounded-xl bg-red-900/60 text-red-400 hover:bg-red-800 transition-colors flex-shrink-0"
            title="Stop"
          >
            <StopCircle size={20} />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!value.trim()}
            className="p-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white transition-colors flex-shrink-0"
            title="Send (Enter)"
          >
            <Send size={20} />
          </button>
        )}
      </div>
      <p className="text-center text-xs text-gray-400 dark:text-gray-600 mt-1.5">
        Enter to send · Shift+Enter for newline
      </p>
    </div>
  );
}
