"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { ChevronLeft, ChevronRight, Loader2, FlaskConical, Menu, MessageSquare } from "lucide-react";
import { isAuthenticated } from "@/lib/auth";
import { useSessionStore } from "@/store/sessionStore";
import { useProjectStore } from "@/store/projectStore";
import SessionSidebar from "@/components/sidebar/SessionSidebar";
import MDWorkspace from "@/components/workspace/MDWorkspace";
const ChatWindow = dynamic(() => import("@/components/chat/ChatWindow"), { ssr: false });
const ChatInput = dynamic(() => import("@/components/chat/ChatInput"), { ssr: false });

// Track a mobile viewport (Tailwind's md breakpoint = 768px).
function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return mobile;
}

export default function App() {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [autoSend, setAutoSend] = useState("");
  const [showNewSession, setShowNewSession] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const isMobile = useIsMobile();

  const { fetchSimulations, loadMessages, persistMessages, clearMessages } = useSessionStore();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  // Auth check — redirect to /login if not authenticated. Projects and their
  // simulations are loaded by the sidebar (projects-first navigation).
  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
      return;
    }
    setHydrated(true);
  }, [router]);

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
    if (activeProjectId) fetchSimulations(activeProjectId);
  };

  const handleNewSession = () => {
    setShowNewSession(true);
    setSessionId(null);
  };

  const activeSessionId = showNewSession ? null : sessionId;
  const chatExpanded = isMobile ? true : rightPanelOpen;
  const closeChat = () => (isMobile ? setMobileChatOpen(false) : setRightPanelOpen(false));

  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* Mobile top bar (hidden on desktop) */}
      <div className="md:hidden flex items-center justify-between px-2 h-12 flex-shrink-0 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
        <button
          onClick={() => setMobileSidebarOpen(true)}
          className="p-2 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          aria-label="Open projects menu"
        >
          <Menu size={18} />
        </button>
        <div className="flex items-center gap-1.5">
          <div className="w-5 h-5 rounded bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
            <FlaskConical size={11} className="text-white" />
          </div>
          <span className="text-sm font-semibold">AMD</span>
        </div>
        <button
          onClick={() => setMobileChatOpen(true)}
          className="p-2 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          aria-label="Open AI assistant"
        >
          <MessageSquare size={18} />
        </button>
      </div>

      {/* Content row */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Sidebar backdrop (mobile only) */}
        {mobileSidebarOpen && (
          <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setMobileSidebarOpen(false)} />
        )}

        {/* Left: session sidebar — off-canvas drawer on mobile, static column on desktop */}
        <div
          className={`fixed inset-y-0 left-0 z-40 md:static md:z-auto transform transition-transform duration-200 ${
            mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"
          } md:translate-x-0`}
        >
          <SessionSidebar
            onNewSession={() => { handleNewSession(); setMobileSidebarOpen(false); }}
            onSelectSession={(id) => {
              if (sessionId) persistMessages(sessionId);
              clearMessages();
              setSessionId(id);
              setShowNewSession(false);
              loadMessages(id);
              setMobileSidebarOpen(false);
            }}
            onSessionDeleted={(id) => { if (sessionId === id) setSessionId(null); }}
          />
        </div>

        {/* Middle: MD workspace */}
        <MDWorkspace
          sessionId={activeSessionId}
          showNewForm={showNewSession}
          onSessionCreated={handleSessionCreated}
          onNewSession={handleNewSession}
        />

        {/* Chat backdrop (mobile only) */}
        {mobileChatOpen && (
          <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setMobileChatOpen(false)} />
        )}

        {/* Right: chat panel — off-canvas drawer on mobile, collapsible column on desktop */}
        <aside
          className={`flex flex-col bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 overflow-x-hidden fixed inset-y-0 right-0 z-40 w-full max-w-sm transform transition-transform duration-200 ${
            mobileChatOpen ? "translate-x-0" : "translate-x-full"
          } md:static md:z-auto md:translate-x-0 md:transition-all ${rightPanelOpen ? "md:w-96" : "md:w-10"}`}
        >
          {chatExpanded ? (
            <>
              <div className="px-4 py-3.5 border-b border-gray-200 dark:border-gray-800 flex-shrink-0 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">AI Assistant</h2>
                  <p className="text-xs text-gray-500 mt-0.5">Claude Opus 4.6</p>
                </div>
                <button
                  onClick={closeChat}
                  title="Close panel"
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
            /* Collapsed rail — desktop only (mobile always shows the expanded drawer) */
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
    </div>
  );
}
