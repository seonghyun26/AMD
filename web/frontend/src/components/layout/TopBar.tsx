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
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

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
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow">
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
        <div ref={ref} className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded-full shadow hover:opacity-90 transition-opacity"
            title={username}
          >
            <UserAvatar size={32} fallback="initial" className="rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-white text-sm font-semibold" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl overflow-hidden z-50">
              <div className="px-3.5 py-2.5 border-b border-gray-100 dark:border-gray-700">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{username}</div>
                <div className="text-[10px] text-gray-400 dark:text-gray-500">Signed in</div>
              </div>
              <button onClick={() => { setMenuOpen(false); setServerOpen(true); }} className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/60">
                <Monitor size={15} /> Server Status
              </button>
              <button onClick={() => { setMenuOpen(false); setSettingsOpen(true); }} className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/60">
                <Settings size={15} /> Settings
              </button>
              <div className="border-t border-gray-100 dark:border-gray-700" />
              <button onClick={() => { logout(); router.push("/login"); }} className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-600 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-50 dark:hover:bg-gray-700/60">
                <LogOut size={15} /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>

      {settingsOpen && <SettingsModal username={username} onClose={() => setSettingsOpen(false)} />}
      {serverOpen && <ServerStatusModal onClose={() => setServerOpen(false)} />}
    </header>
  );
}
