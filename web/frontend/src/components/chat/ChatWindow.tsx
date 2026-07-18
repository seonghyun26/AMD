"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/store/sessionStore";
import MessageBubble from "./MessageBubble";
import { ChevronDown, Loader2 } from "lucide-react";

export default function ChatWindow() {
  const messages = useSessionStore((s) => s.messages);
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const containerRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    nearBottomRef.current = nearBottom;
    setShowScrollButton(el.scrollHeight > el.clientHeight && !nearBottom);
  }, []);

  // Auto-scroll to the latest message — but scroll ONLY this container (using
  // scrollIntoView would scroll every ancestor, i.e. the whole page), and only
  // when the user is already near the bottom (don't yank them down mid-read).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
    const frameId = requestAnimationFrame(updateScrollState);
    return () => cancelAnimationFrame(frameId);
  }, [messages, isStreaming, updateScrollState]);

  const scrollToBottom = () => {
    const el = containerRef.current;
    if (!el) return;
    nearBottomRef.current = true;
    setShowScrollButton(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-600">
        <div className="text-center">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">AI Assistant</p>
          <p className="text-xs mt-1 text-gray-400 dark:text-gray-600">Configure your simulation in the<br />middle panel and start chatting</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={containerRef}
        onScroll={updateScrollState}
        className="h-full overflow-y-auto overflow-x-hidden"
      >
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {isStreaming && (
          <div className="flex px-4 py-3">
            <div className="flex items-center gap-2 text-gray-400">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-sm">Thinking…</span>
            </div>
          </div>
        )}
      </div>

      {showScrollButton && (
        <button
          type="button"
          onClick={scrollToBottom}
          title="Scroll to latest message"
          aria-label="Scroll to latest message"
          className="absolute bottom-3 right-3 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 shadow-md transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          <ChevronDown size={16} />
        </button>
      )}
    </div>
  );
}
