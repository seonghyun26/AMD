"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { ChevronLeft, ChevronRight, Loader2, FlaskConical } from "lucide-react";
import { isAuthenticated } from "@/lib/auth";
import { useSessionStore } from "@/store/sessionStore";
import SessionSidebar from "@/components/sidebar/SessionSidebar";
import MDWorkspace from "@/components/workspace/MDWorkspace";
const ChatWindow = dynamic(() => import("@/components/chat/ChatWindow"), { ssr: false });
const ChatInput = dynamic(() => import("@/components/chat/ChatInput"), { ssr: false });

export default function App() {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [autoSend, setAutoSend] = useState("");
  const [showNewSession, setShowNewSession] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);

  const { addSession, fetchSessions, loadMessages, persistMessages, clearMessages } = useSessionStore();

  // Auth check — redirect to /login if not authenticated; load session list
  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
      return;
    }
    setHydrated(true);
    fetchSessions();
  }, [router, fetchSessions]);

  const sessionsLoading = useSessionStore((s) => s.sessionsLoading);

  if (!hydrated) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="flex flex-col items-center gap-4">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg">
            <FlaskConical size={28} className="text-white" />
          </div>
          <div className="flex items-center gap-2 text-gray-400 dark:text-gray-500">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-sm font-medium">Loading...</span>
          </div>
        </div>
      </div>
    );
  }

  const handleSessionCreated = (id: string, workDir: string, nickname: string) => {
    // MDWorkspace already called addSession with selected_molecule — don't overwrite it here.
    setSessionId(id);
    setShowNewSession(false);
    fetchSessions();
  };

  const handleNewSession = () => {
    setShowNewSession(true);
    setSessionId(null);
  };

  const activeSessionId = showNewSession ? null : sessionId;

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* Left: Session sidebar */}
      <SessionSidebar
        onNewSession={handleNewSession}
        onSelectSession={(id) => {
          // Persist current session's messages before switching
          if (sessionId) persistMessages(sessionId);
          clearMessages();
          setSessionId(id);
          setShowNewSession(false);
          loadMessages(id);
        }}
        onSessionDeleted={(id) => {
          if (sessionId === id) setSessionId(null);
        }}
      />

      {/* Middle: MD Workspace */}
      <MDWorkspace
        sessionId={activeSessionId}
        showNewForm={showNewSession}
        onSessionCreated={handleSessionCreated}
        onNewSession={handleNewSession}
      />

      {/* Right: Chat panel */}
      <aside
        className={`flex-shrink-0 border-l border-gray-200 dark:border-gray-800 flex flex-col bg-white dark:bg-gray-900 overflow-x-hidden transition-all duration-200 ${
          rightPanelOpen ? "w-96" : "w-10"
        }`}
      >
        {rightPanelOpen ? (
          <>
            <div className="px-4 py-3.5 border-b border-gray-200 dark:border-gray-800 flex-shrink-0 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">AI Assistant</h2>
                <p className="text-xs text-gray-500 mt-0.5">Claude Opus 4.6</p>
              </div>
              <button
                onClick={() => setRightPanelOpen(false)}
                title="Collapse panel"
                className="p-1.5 rounded-lg text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors flex-shrink-0"
              >
                <ChevronRight size={15} />
              </button>
            </div>

            <div className="flex-1 overflow-hidden flex flex-col min-h-0">
              <ChatWindow />
              {activeSessionId ? (
                <ChatInput
                  sessionId={activeSessionId}
                  autoSend={autoSend}
                  onAutoSendComplete={() => setAutoSend("")}
                />
              ) : (
                <div className="p-3 border-t border-gray-200 dark:border-gray-800 text-xs text-gray-500 text-center">
                  Create a session to start chatting
                </div>
              )}
            </div>
          </>
        ) : (
          <button
            onClick={() => setRightPanelOpen(true)}
            title="Expand AI Assistant panel"
            className="flex-1 flex flex-col items-center justify-center gap-3 text-gray-400 dark:text-gray-600 hover:text-gray-900 dark:hover:text-gray-300 transition-colors"
          >
            <ChevronLeft size={15} />
            <span
              className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-600"
              style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
            >
              AI Assistant
            </span>
          </button>
        )}
      </aside>
    </div>
  );
}
