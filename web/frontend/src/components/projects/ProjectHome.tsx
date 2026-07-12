"use client";

import { useEffect, useState } from "react";
import { FolderPlus, Trash2, Check, X, Loader2 } from "lucide-react";
import { useProjectStore } from "@/store/projectStore";

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-12 h-12 text-blue-500/85 drop-shadow-sm" fill="currentColor">
      <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
    </svg>
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
      <div className="p-6 md:p-10">
        <p className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-600 mb-4">Your projects</p>
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
