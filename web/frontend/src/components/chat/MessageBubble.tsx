"use client";

import { useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ToolCallBlock } from "@/lib/types";
import { useSessionStore } from "@/store/sessionStore";
import AssistantAvatar from "@/components/common/AssistantAvatar";
import ThinkingBlock from "./ThinkingBlock";
import ToolCallCard, { ToolCallGroupCard } from "./ToolCallCard";

const BACKGROUND_TOOL_NAMES = new Set([
  "read_shell",
  "command_execution",
  "exec_command",
  "write_stdin",
  "wait",
  "job",
  "jobs",
  "job_start",
  "job_status",
  "wait_job",
]);

function isBackgroundTool(block: ToolCallBlock): boolean {
  return BACKGROUND_TOOL_NAMES.has(block.tool_name) || /(?:^|[._-])jobs?(?:$|[._-])/.test(block.tool_name);
}

/** Highlight `@simulation` mentions in a sent user message. Matches against the
 *  project's known simulation names (longest first) so names with spaces work. */
function renderMentions(text: string, names: string[]): ReactNode {
  if (!text.includes("@") || names.length === 0) return text;
  const sorted = [...names].filter(Boolean).sort((a, b) => b.length - a.length);
  const out: ReactNode[] = [];
  let buf = "";
  let i = 0;
  const flush = () => { if (buf) { out.push(buf); buf = ""; } };
  while (i < text.length) {
    if (text[i] === "@") {
      const rest = text.slice(i + 1);
      const hit = sorted.find((n) => rest.startsWith(n));
      if (hit) {
        flush();
        out.push(
          <span key={i} className="amd-user-message-mention">
            @{hit}
          </span>,
        );
        i += 1 + hit.length;
        continue;
      }
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return out;
}

export default function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const sessions = useSessionStore((s) => s.sessions);
  const names = useMemo(() => sessions.map((s) => s.nickname).filter(Boolean), [sessions]);
  const backgroundTools = useMemo(
    () => message.blocks.filter(
      (block): block is ToolCallBlock => block.kind === "tool_call" && isBackgroundTool(block),
    ),
    [message.blocks],
  );
  const groupedBackground = backgroundTools.length > 1;
  const firstBackgroundId = backgroundTools[0]?.tool_use_id;

  return (
    <div className={`flex gap-3 px-4 py-3 ${isUser ? "justify-end" : "justify-start"}`}>
      {/* Avatar */}
      {!isUser && <AssistantAvatar />}

      {/* Content */}
      <div className={`max-w-[80%] min-w-0 space-y-1 ${isUser ? "items-end" : "items-start"} flex flex-col`}>
        {message.blocks.map((block, i) => {
          if (block.kind === "text") {
            return (
              <div
                key={i}
                className={`px-4 py-2.5 text-sm leading-relaxed break-words ${
                  isUser
                    ? "amd-user-message rounded-xl"
                    : "rounded-2xl bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                }`}
              >
                {isUser ? (
                  <div>
                    {block.title && (
                      <div className="amd-user-message-title text-[11px] font-semibold uppercase tracking-wide mb-1 pb-1 border-b">
                        {block.title}
                      </div>
                    )}
                    <p className="whitespace-pre-wrap break-words">{renderMentions(block.content, names)}</p>
                  </div>
                ) : (
                  <div className="prose prose-sm dark:prose-invert max-w-none [&_pre]:whitespace-pre-wrap [&_pre]:break-all prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-code:text-indigo-600 dark:prose-code:text-cyan-300">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {block.content}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            );
          }
          if (block.kind === "thinking") {
            return <ThinkingBlock key={i} block={block} />;
          }
          if (block.kind === "tool_call") {
            if (groupedBackground && isBackgroundTool(block)) {
              if (block.tool_use_id !== firstBackgroundId) return null;
              return <ToolCallGroupCard key={`activity-${message.id}`} blocks={backgroundTools} />;
            }
            return <ToolCallCard key={block.tool_use_id} block={block} />;
          }
          if (block.kind === "error") {
            return (
              <div key={i} className="rounded-xl px-4 py-2.5 text-sm bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 whitespace-pre-wrap break-words">
                ⚠️ {block.content}
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
