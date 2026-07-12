"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FolderPlus, Trash2, Check, X, Loader2, FlaskConical, Settings, Monitor, LogOut } from "lucide-react";
import { useProjectStore } from "@/store/projectStore";
import { getUsername, logout } from "@/lib/auth";
import { SettingsModal, ServerStatusModal } from "@/components/sidebar/SessionSidebar";

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-12 h-12 text-blue-500/85 drop-shadow-sm" fill="currentColor">
      <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
    </svg>
  );
}

function ProfileMenu() {
  const router = useRouter();
  const username = getUsername() || "user";
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverOpen, setServerOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white text-sm font-semibold shadow hover:opacity-90 transition-opacity"
        title={username}
      >
        {username[0]?.toUpperCase() ?? "?"}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl overflow-hidden z-50">
          <button onClick={() => { setOpen(false); setServerOpen(true); }} className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/60">
            <Monitor size={15} /> Server Status
          </button>
          <button onClick={() => { setOpen(false); setSettingsOpen(true); }} className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/60">
            <Settings size={15} /> Settings
          </button>
          <div className="border-t border-gray-100 dark:border-gray-700" />
          <button onClick={() => { logout(); router.push("/login"); }} className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-600 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-50 dark:hover:bg-gray-700/60">
            <LogOut size={15} /> Sign out
          </button>
        </div>
      )}
      {settingsOpen && <SettingsModal username={username} onClose={() => setSettingsOpen(false)} />}
      {serverOpen && <ServerStatusModal onClose={() => setServerOpen(false)} />}
    </div>
  );
}

export default function ProjectHome({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const { projects, projectsLoading, fetchProjects, createAndSelect, deleteProjectById } = useProjectStore();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const submit = async () => {
    const name = newName.trim();
    setNewName("");
    setCreating(false);
    if (!name) return;
    const p = await createAndSelect(name);
    if (p) onOpenProject(p.project_id);
  };

  return (
    <div className="flex-1 min-w-0 overflow-y-auto bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-6 md:px-10 py-4 border-b border-gray-200 dark:border-gray-800 sticky top-0 bg-gray-50/90 dark:bg-gray-950/90 backdrop-blur z-10">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow">
            <FlaskConical size={16} className="text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900 dark:text-white leading-tight">Projects</h1>
            <p className="text-xs text-gray-400 dark:text-gray-500">Automating MD</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            <FolderPlus size={13} /> New Project
          </button>
          <ProfileMenu />
        </div>
      </div>

      {/* Grid */}
      <div className="p-6 md:p-10">
        {projectsLoading && projects.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-gray-400 dark:text-gray-600">
            <Loader2 size={14} className="animate-spin" /> Loading projects…
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-5">
            {creating ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-blue-400 dark:border-blue-600 p-4 aspect-square">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                    if (e.key === "Escape") { setCreating(false); setNewName(""); }
                  }}
                  placeholder="Project name"
                  className="w-full text-xs text-center bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <div className="flex gap-3">
                  <button onClick={submit} className="text-emerald-500 hover:text-emerald-400"><Check size={16} /></button>
                  <button onClick={() => { setCreating(false); setNewName(""); }} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="group flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-gray-300 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-600 p-4 aspect-square transition-colors"
              >
                <FolderPlus size={40} className="text-gray-300 dark:text-gray-600 group-hover:text-blue-400 transition-colors" />
                <span className="text-xs font-medium text-gray-400 dark:text-gray-500 group-hover:text-blue-500">New Project</span>
              </button>
            )}

            {projects.map((p) => (
              <div
                key={p.project_id}
                onClick={() => onOpenProject(p.project_id)}
                className="group relative flex flex-col items-center justify-center gap-2 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-md p-4 aspect-square cursor-pointer transition-all"
              >
                <FolderIcon />
                <span className="text-sm font-semibold text-gray-800 dark:text-gray-200 text-center truncate max-w-full px-1">{p.name}</span>
                <span className="text-[11px] text-gray-400 dark:text-gray-500">
                  {(p.simulation_count ?? 0)} simulation{(p.simulation_count ?? 0) === 1 ? "" : "s"}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteProjectById(p.project_id); }}
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 rounded-md text-gray-300 dark:text-gray-600 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all"
                  title="Delete project"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
