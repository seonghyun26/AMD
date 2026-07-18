"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FlaskConical, Settings, Monitor, LogOut, FolderOpen, Menu, MessageSquare, ArrowLeft } from "lucide-react";
import { getUsername, logout } from "@/lib/auth";
import { SettingsModal, ServerStatusModal } from "@/components/sidebar/SessionSidebar";
import UserAvatar from "@/components/common/UserAvatar";
import { useProjectStore } from "@/store/projectStore";
import type { Project } from "@/lib/types";

export default function TopBar({
  activeProject,
  onBack,
  onOpenSidebar,
  onOpenChat,
}: {
  activeProject: Project | null;
  onBack: () => void;
  onOpenSidebar: () => void;
  onOpenChat: () => void;
}) {
  const router = useRouter();
  const username = getUsername() || "user";
  const renameProject = useProjectStore((s) => s.renameProject);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverOpen, setServerOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const skipSave = useRef(false);
  const ref = useRef<HTMLDivElement>(null);

  const saveName = () => {
    if (skipSave.current) { skipSave.current = false; setEditingName(false); return; }
    setEditingName(false);
    const name = nameDraft.trim();
    if (activeProject && name && name !== activeProject.name) {
      renameProject(activeProject.project_id, name);
    }
  };

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const profileActions = [
    {
      label: "Server status",
      icon: <Monitor size={15} />,
      tone: "text-cyan-600 dark:text-cyan-300",
      onClick: () => { setMenuOpen(false); setServerOpen(true); },
    },
    {
      label: "Settings",
      icon: <Settings size={15} />,
      tone: "text-indigo-600 dark:text-indigo-300",
      onClick: () => { setMenuOpen(false); setSettingsOpen(true); },
    },
    {
      label: "Sign out",
      icon: <LogOut size={15} />,
      tone: "text-rose-500 dark:text-rose-300",
      onClick: () => { setMenuOpen(false); logout(); router.push("/login"); },
    },
  ];

  return (
    <header className="w-full flex items-center justify-between gap-3 px-3 md:px-4 h-14 flex-shrink-0 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 z-30">
      <div className="flex items-center gap-2 min-w-0">
        {activeProject && (
          <button
            onClick={onBack}
            className="p-1.5 -ml-1 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex-shrink-0"
            aria-label="Back to projects"
            title="Back to projects"
          >
            <ArrowLeft size={18} />
          </button>
        )}
        {activeProject && (
          <button
            onClick={onOpenSidebar}
            className="md:hidden p-2 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
            aria-label="Open simulations"
          >
            <Menu size={18} />
          </button>
        )}
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="amd-brand-mark w-7 h-7 rounded-lg flex items-center justify-center shadow">
            <FlaskConical size={14} className="text-white" />
          </div>
          <span className="text-sm font-bold text-gray-900 dark:text-white">AMD</span>
        </div>
        <span className="text-gray-300 dark:text-gray-700 hidden sm:inline">/</span>
        {activeProject ? (
          <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-200 truncate min-w-0">
            <FolderOpen size={14} className="text-blue-500/70 flex-shrink-0" />
            {editingName ? (
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveName();
                  if (e.key === "Escape") { skipSave.current = true; setEditingName(false); }
                }}
                onBlur={saveName}
                className="min-w-0 w-44 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-1.5 py-0.5 text-sm font-semibold text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            ) : (
              <button
                onClick={() => { setNameDraft(activeProject.name); setEditingName(true); }}
                title="Rename project"
                className="truncate hover:underline decoration-dotted underline-offset-2"
              >
                {activeProject.name}
              </button>
            )}
          </span>
        ) : (
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-200 hidden sm:inline">Projects</span>
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          onClick={onOpenChat}
          className="md:hidden p-2 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
          aria-label="Open AI assistant"
        >
          <MessageSquare size={18} />
        </button>
        <div
          ref={ref}
          className={`profile-system-menu relative flex h-9 w-9 items-center justify-center ${menuOpen ? "profile-system-menu-open" : ""}`}
        >
          {profileActions.map((action, index) => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              aria-label={action.label}
              title={action.label}
              tabIndex={menuOpen ? 0 : -1}
              className={`profile-system-action group absolute right-0 top-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-gray-300/80 bg-white/90 backdrop-blur-md hover:border-gray-400 dark:border-gray-600/80 dark:bg-slate-900/90 dark:hover:border-gray-500 ${action.tone} ${
                menuOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
              }`}
              style={{
                transform: menuOpen
                  ? `translate3d(-${52 + 42 * index}px, -50%, 0) scale(1) rotate(0deg)`
                  : "translate3d(2px, -50%, 0) scale(.38) rotate(22deg)",
                transitionDelay: menuOpen
                  ? `${index * 32}ms`
                  : `${(profileActions.length - index - 1) * 38}ms`,
              }}
            >
              <span className="profile-system-action-glyph flex h-full w-full items-center justify-center rounded-full">
                {action.icon}
              </span>
              <span className="pointer-events-none absolute top-full mt-2 whitespace-nowrap rounded-md border border-cyan-200/60 bg-white/95 px-2 py-1 text-[10px] font-medium text-slate-600 opacity-0 shadow-md backdrop-blur transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100 dark:border-cyan-400/20 dark:bg-slate-900/95 dark:text-cyan-100">
                {action.label}
              </span>
            </button>
          ))}
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close profile actions" : "Open profile actions"}
            className={`profile-system-avatar relative z-20 rounded-full shadow-md ${menuOpen ? "profile-system-avatar-open" : ""}`}
            title={username}
          >
            <UserAvatar size={34} fallback="initial" className="amd-brand-mark rounded-full text-slate-900 text-sm font-semibold" />
          </button>
        </div>
      </div>

      {settingsOpen && <SettingsModal username={username} onClose={() => setSettingsOpen(false)} />}
      {serverOpen && <ServerStatusModal onClose={() => setServerOpen(false)} />}
    </header>
  );
}
