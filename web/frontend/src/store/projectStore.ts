import { create } from "zustand";
import type { Project } from "@/lib/types";
import { createProject, deleteProject, listProjects, updateProjectName } from "@/lib/api";
import { getUsername } from "@/lib/auth";

interface ProjectState {
  projects: Project[];
  activeProjectId: string | null;
  projectsLoading: boolean;

  fetchProjects: () => Promise<void>;
  setActiveProject: (id: string | null) => void;
  addProject: (p: Project) => void;
  removeProject: (id: string) => void;
  createAndSelect: (name: string) => Promise<Project | null>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProjectById: (id: string) => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  projectsLoading: true,

  fetchProjects: async () => {
    const u = getUsername();
    if (!u) {
      set({ projectsLoading: false });
      return;
    }
    try {
      set({ projectsLoading: true });
      const { projects } = await listProjects(u);
      set({ projects, projectsLoading: false });
    } catch {
      set({ projectsLoading: false });
    }
  },

  setActiveProject: (id) => set({ activeProjectId: id }),

  addProject: (p) =>
    set((s) => ({
      projects: [p, ...s.projects.filter((x) => x.project_id !== p.project_id)],
    })),

  removeProject: (id) =>
    set((s) => ({
      projects: s.projects.filter((p) => p.project_id !== id),
      activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
    })),

  createAndSelect: async (name) => {
    const u = getUsername();
    if (!u) return null;
    try {
      const { project } = await createProject({ name: name.trim() || "Untitled Project", username: u });
      get().addProject(project);
      set({ activeProjectId: project.project_id });
      return project;
    } catch {
      return null;
    }
  },

  renameProject: async (id, name) => {
    try {
      await updateProjectName(id, name);
    } catch {
      /* ignore */
    }
    set((s) => ({
      projects: s.projects.map((p) => (p.project_id === id ? { ...p, name } : p)),
    }));
  },

  deleteProjectById: async (id) => {
    try {
      await deleteProject(id);
    } catch {
      /* ignore */
    }
    get().removeProject(id);
  },
}));
