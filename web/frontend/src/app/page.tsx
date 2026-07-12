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
import ProjectHome from "@/components/projects/ProjectHome";
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

  const { fetchSimulations, loadAssistant } = useSessionStore();
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
        className={`flex flex-col bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 overflow-x-hidden fixed inset-y-0 z-40 w-full max-w-sm transition-[right] duration-200 ${
          mobileChatOpen ? "right-0" : "-right-full"
        } md:static md:right-auto md:z-auto ${rightPanelOpen ? "md:w-96" : "md:w-10"}`}
      >
        {chatExpanded ? (
          <>
            <div className="px-4 py-3.5 border-b border-gray-200 dark:border-gray-800 flex-shrink-0 flex items-center justify-between">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">AI Assistant</h2>
                <p className="text-xs text-gray-500 mt-0.5 truncate">{activeProject ? activeProject.name : "General"}</p>
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
              <ChatInput projectId={activeProjectId} />
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
    <div className="flex flex-col md:flex-row h-screen overflow-hidden bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* Mobile top bar */}
      <div className="md:hidden flex items-center justify-between px-2 h-12 flex-shrink-0 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
        {activeProjectId ? (
          <button onClick={() => setMobileSidebarOpen(true)} className="p-2 rounded-lg text-gray-600 dark:text-gray-300" aria-label="Open simulations">
            <Menu size={18} />
          </button>
        ) : (
          <span className="w-9" />
        )}
        <div className="flex items-center gap-1.5">
          <div className="w-5 h-5 rounded bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
            <FlaskConical size={11} className="text-white" />
          </div>
          <span className="text-sm font-semibold">AMD</span>
        </div>
        <button onClick={() => setMobileChatOpen(true)} className="p-2 rounded-lg text-gray-600 dark:text-gray-300" aria-label="Open AI assistant">
          <MessageSquare size={18} />
        </button>
      </div>

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
              className={`fixed inset-y-0 z-40 md:static md:z-auto transition-[left] duration-200 ${
                mobileSidebarOpen ? "left-0" : "-left-64"
              } md:left-auto`}
            >
              <SessionSidebar
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
