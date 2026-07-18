"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { ChevronLeft, ChevronRight, Loader2, FlaskConical, Trash2 } from "lucide-react";
import { isAuthenticated } from "@/lib/auth";
import { useSessionStore } from "@/store/sessionStore";
import { useProjectStore } from "@/store/projectStore";
import SessionSidebar from "@/components/sidebar/SessionSidebar";
import MDWorkspace from "@/components/workspace/MDWorkspace";
import ProjectHome from "@/components/projects/ProjectHome";
import TopBar from "@/components/layout/TopBar";
const ChatWindow = dynamic(() => import("@/components/chat/ChatWindow"), { ssr: false });
const ChatInput = dynamic(() => import("@/components/chat/ChatInput"), { ssr: false });

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
  const [showNewSession, setShowNewSession] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const isMobile = useIsMobile();

  // Collapsible simulation list (desktop) — fold to a thin rail on the left.
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  useEffect(() => {
    setLeftPanelOpen(localStorage.getItem("amd_sim_list_open") !== "0");
  }, []);
  useEffect(() => {
    try { localStorage.setItem("amd_sim_list_open", leftPanelOpen ? "1" : "0"); } catch { /* ignore */ }
  }, [leftPanelOpen]);

  // Resizable assistant column (desktop) — drag the handle on its left edge.
  const [chatWidth, setChatWidth] = useState(480);
  useEffect(() => {
    const v = Number(localStorage.getItem("amd_chat_width"));
    if (v >= 320 && v <= 900) setChatWidth(v);
  }, []);
  useEffect(() => {
    try { localStorage.setItem("amd_chat_width", String(chatWidth)); } catch { /* ignore */ }
  }, [chatWidth]);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) =>
      setChatWidth(Math.min(Math.max(window.innerWidth - ev.clientX, 320), 900));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const { fetchSimulations, loadAssistant, clearAssistant, messages, isStreaming } = useSessionStore();
  const pendingPrompt = useSessionStore((s) => s.pendingPrompt);
  const [confirmClear, setConfirmClear] = useState(false);
  const { projects, activeProjectId, setActiveProject } = useProjectStore();

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
      return;
    }
    setHydrated(true);
  }, [router]);

  // Load the (project or general) assistant conversation on context change.
  useEffect(() => {
    if (hydrated) loadAssistant(activeProjectId);
  }, [hydrated, activeProjectId, loadAssistant]);

  // Load a project's simulations when it's opened.
  useEffect(() => {
    if (activeProjectId) fetchSimulations(activeProjectId);
  }, [activeProjectId, fetchSimulations]);

  // A workspace shortcut queued a prompt — make sure the assistant panel is open
  // so its ChatInput mounts, consumes the prompt, and streams the answer.
  useEffect(() => {
    if (!pendingPrompt) return;
    if (isMobile) setMobileChatOpen(true);
    else setRightPanelOpen(true);
  }, [pendingPrompt, isMobile]);

  if (!hydrated) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="flex flex-col items-center gap-4">
          <div className="amd-brand-mark inline-flex items-center justify-center w-14 h-14 rounded-2xl shadow-lg">
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

  const handleSessionCreated = (id: string) => {
    setSessionId(id);
    setShowNewSession(false);
    if (activeProjectId) fetchSimulations(activeProjectId);
  };
  const handleNewSession = () => {
    setShowNewSession(true);
    setSessionId(null);
  };
  const openProject = (id: string) => {
    setActiveProject(id);
    setSessionId(null);
    setShowNewSession(false);
  };

  const activeSessionId = showNewSession ? null : sessionId;
  const activeProject = projects.find((p) => p.project_id === activeProjectId) || null;
  const chatExpanded = isMobile ? true : rightPanelOpen;
  const closeChat = () => (isMobile ? setMobileChatOpen(false) : setRightPanelOpen(false));

  // Assistant panel — project-level inside a project, general on the home screen.
  const assistant = (
    <>
      {mobileChatOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setMobileChatOpen(false)} />
      )}
      <aside
        style={!isMobile ? { width: rightPanelOpen ? chatWidth : 40 } : undefined}
        className={`flex flex-col bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 overflow-x-hidden fixed inset-y-0 z-40 w-full max-w-sm md:max-w-none transition-[right,width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          mobileChatOpen ? "right-0" : "-right-full"
        } md:relative md:right-auto md:z-auto`}
      >
        {rightPanelOpen && (
          <div
            onMouseDown={startResize}
            className="hidden md:block absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-400/40 active:bg-blue-500/50 transition-colors z-20"
            title="Drag to resize"
          />
        )}
        {chatExpanded ? (
          <>
            <div className="px-4 py-3.5 border-b border-gray-200 dark:border-gray-800 flex-shrink-0 flex items-center justify-between">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">AI Assistant</h2>
                {activeProject && (
                  <p
                    className="text-[10px] font-mono text-gray-400 dark:text-gray-600 mt-0.5 truncate"
                    title="Attach in a terminal to watch the assistant work live"
                  >
                    tmux attach -t amd-{activeProject.project_id.replace(/^proj_/, "").replace(/[^A-Za-z0-9_-]/g, "") || "project"}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => {
                    if (confirmClear) { clearAssistant(activeProjectId); setConfirmClear(false); }
                    else { setConfirmClear(true); window.setTimeout(() => setConfirmClear(false), 3000); }
                  }}
                  disabled={messages.length === 0 || isStreaming}
                  title="Clear conversation"
                  className={`inline-flex items-center gap-1 rounded-lg transition-colors disabled:opacity-30 disabled:pointer-events-none ${
                    confirmClear
                      ? "px-2 py-1 text-xs font-semibold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40"
                      : "p-1.5 text-gray-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                  }`}
                >
                  <Trash2 size={15} />
                  {confirmClear && <span>Clear?</span>}
                </button>
                <button
                  onClick={closeChat}
                  title="Close panel"
                  className="p-1.5 rounded-lg text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden flex flex-col min-h-0">
              <ChatWindow />
              <ChatInput projectId={activeProjectId} contextSessionId={activeSessionId} />
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
              className="text-[10px] font-semibold uppercase tracking-widest"
              style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
            >
              AI Assistant
            </span>
          </button>
        )}
      </aside>
    </>
  );

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <TopBar
        activeProject={activeProject}
        onBack={() => setActiveProject(null)}
        onOpenSidebar={() => setMobileSidebarOpen(true)}
        onOpenChat={() => setMobileChatOpen(true)}
      />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {activeProjectId === null ? (
          <>
            <ProjectHome onOpenProject={openProject} />
            {assistant}
          </>
        ) : (
          <>
            {mobileSidebarOpen && (
              <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setMobileSidebarOpen(false)} />
            )}
            <div
              className={`fixed inset-y-0 z-40 md:static md:z-auto transition-[left] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                mobileSidebarOpen ? "left-0" : "-left-64"
              } md:left-auto`}
            >
              <SessionSidebar
                collapsed={!isMobile && !leftPanelOpen}
                onToggleCollapse={() => setLeftPanelOpen((v) => !v)}
                onNewSession={() => { handleNewSession(); setMobileSidebarOpen(false); }}
                onSelectSession={(id) => {
                  setSessionId(id);
                  setShowNewSession(false);
                  setMobileSidebarOpen(false);
                }}
                onSessionDeleted={(id) => { if (sessionId === id) setSessionId(null); }}
              />
            </div>

            <MDWorkspace
              sessionId={activeSessionId}
              showNewForm={showNewSession}
              onSessionCreated={handleSessionCreated}
              onNewSession={handleNewSession}
            />

            {assistant}
          </>
        )}
      </div>
    </div>
  );
}
