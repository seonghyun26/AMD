import type { ConfigOptions, SessionConfig } from "./types";
import { getToken } from "./auth";

const BASE = "/api";

// ── Authenticated fetch wrapper ──────────────────────────────────────

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getToken();
  const headers: Record<string, string> = { ...extra };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/** fetch() wrapper that injects the JWT Authorization header. */
function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}

// ── Auth ──────────────────────────────────────────────────────────────

export async function loginUser(
  username: string,
  password: string
): Promise<{ success: boolean; username?: string; token?: string }> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) return { success: false };
  return { success: true, ...(await res.json()) };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg: string;
    try {
      const body = await res.json();
      msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body);
    } catch {
      msg = await res.text().catch(() => res.statusText);
    }
    throw new Error(`${res.status}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

// ── Sessions ──────────────────────────────────────────────────────────

export async function createSession(
  params: { workDir: string; nickname: string; username: string; preset: string; system?: string; state?: string; gromacs?: string }
): Promise<{ session_id: string; work_dir: string; nickname: string; seeded_files: string[] }> {
  const res = await authFetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      work_dir: params.workDir,
      nickname: params.nickname,
      username: params.username,
      preset: params.preset,
      system: params.system ?? "",
      state: params.state ?? "",
      gromacs: params.gromacs ?? "",
    }),
  });
  return json(res);
}

export async function listSessions(username: string): Promise<{
  sessions: {
    session_id: string;
    work_dir: string;
    nickname: string;
    run_status?: "standby" | "running" | "finished" | "failed";
    selected_molecule?: string;
    updated_at?: string;
  }[];
}> {
  return json(await authFetch(`${BASE}/sessions?username=${encodeURIComponent(username)}`));
}

export async function getSessionRunStatus(
  sessionId: string
): Promise<{ run_status: string; started_at?: number; finished_at?: number }> {
  return json(await authFetch(`${BASE}/sessions/${sessionId}/run-status`));
}

export async function restoreSession(
  sessionId: string,
  workDir: string,
  nickname = "",
  username = ""
): Promise<void> {
  await authFetch(`${BASE}/sessions/${sessionId}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ work_dir: workDir, nickname, username }),
  }).catch(() => {});
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
}

export async function updateSessionMolecule(
  sessionId: string,
  selectedMolecule: string
): Promise<{ session_id: string; selected_molecule: string }> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}/molecule`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selected_molecule: selectedMolecule }),
  });
  return json(res);
}

export async function updateNickname(
  sessionId: string,
  nickname: string
): Promise<{ session_id: string; nickname: string }> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}/nickname`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname }),
  });
  return json(res);
}

// ── Config ────────────────────────────────────────────────────────────

export async function getConfigOptions(): Promise<ConfigOptions> {
  return json(await authFetch(`${BASE}/config/options`));
}

export async function getSessionConfig(sessionId: string): Promise<{ config: Record<string, unknown> }> {
  return json(await authFetch(`${BASE}/sessions/${sessionId}/config`));
}

export async function updateSessionConfig(
  sessionId: string,
  updates: Record<string, unknown>
): Promise<{ updated: boolean }> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  });
  return json(res);
}

export async function generateSessionFiles(
  sessionId: string
): Promise<{ generated: string[]; work_dir: string }> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}/generate-files`, {
    method: "POST",
  });
  return json(res);
}

// ── Files ─────────────────────────────────────────────────────────────

export async function listFiles(
  sessionId: string,
  pattern = "*"
): Promise<{ files: string[]; work_dir: string }> {
  return json(await authFetch(`${BASE}/sessions/${sessionId}/files?pattern=${encodeURIComponent(pattern)}`));
}

export async function uploadFile(
  sessionId: string,
  file: File
): Promise<{ saved_path: string; size_bytes: number }> {
  const form = new FormData();
  form.append("file", file);
  const res = await authFetch(`${BASE}/sessions/${sessionId}/files/upload`, {
    method: "POST",
    body: form,
  });
  return json(res);
}

export function downloadUrl(sessionId: string, path: string): string {
  return `${BASE}/sessions/${sessionId}/files/download?path=${encodeURIComponent(path)}`;
}

export function downloadZipUrl(sessionId: string): string {
  return `${BASE}/sessions/${sessionId}/files/download-zip`;
}

export async function deleteFile(sessionId: string, path: string): Promise<{ archived: string }> {
  const res = await authFetch(
    `${BASE}/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`,
    { method: "DELETE" }
  );
  return json(res);
}

export async function listArchiveFiles(sessionId: string): Promise<{ files: string[] }> {
  return json(await authFetch(`${BASE}/sessions/${sessionId}/files/archive`));
}

export async function restoreFile(sessionId: string, path: string): Promise<{ restored: string }> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}/files/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return json(res);
}

export async function getFileContent(sessionId: string, path: string): Promise<string> {
  const res = await authFetch(downloadUrl(sessionId, path));
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
  return res.text();
}

// ── PDB fetch ────────────────────────────────────────────────────────

export async function fetchPdb(
  sessionId: string,
  pdbId: string
): Promise<{ saved_path: string; filename: string; size_bytes: number }> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}/pdb/fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pdb_id: pdbId }),
  });
  return json(res);
}

// ── Analysis ──────────────────────────────────────────────────────────

export async function getColvar(
  sessionId: string,
  filename = "COLVAR",
  maxPoints = 5000,
): Promise<{ data: Record<string, number[]>; available: boolean }> {
  return json(await authFetch(`${BASE}/sessions/${sessionId}/analysis/colvar?filename=${filename}&max_points=${maxPoints}`));
}

export async function getRamachandranData(
  sessionId: string,
  force = false,
): Promise<{ data: { phi: number[]; psi: number[] }; available: boolean }> {
  const qs = force ? "?force=true" : "";
  return json(await authFetch(`${BASE}/sessions/${sessionId}/analysis/ramachandran${qs}`));
}

export interface RamachandranPlotSettings {
  dpi?: number;
  bins?: number;
  cmap?: string;
  log_scale?: boolean;
  show_start?: boolean;
}

export function getRamachandranImageUrl(
  sessionId: string,
  force = false,
  cacheBust = 0,
  settings?: RamachandranPlotSettings,
): string {
  const params = new URLSearchParams();
  if (force) params.set("force", "true");
  if (cacheBust) params.set("_t", String(cacheBust));
  if (settings) {
    if (settings.dpi !== undefined) params.set("dpi", String(settings.dpi));
    if (settings.bins !== undefined) params.set("bins", String(settings.bins));
    if (settings.cmap !== undefined) params.set("cmap", settings.cmap);
    if (settings.log_scale !== undefined) params.set("log_scale", String(settings.log_scale));
    if (settings.show_start !== undefined) params.set("show_start", String(settings.show_start));
  }
  const qs = params.size ? `?${params}` : "";
  return `${BASE}/sessions/${sessionId}/analysis/ramachandran.png${qs}`;
}

export async function getFes(
  sessionId: string,
  filename = "fes.dat"
): Promise<{ data: { x: number[]; y: number[]; z: number[][] }; available: boolean }> {
  return json(await authFetch(`${BASE}/sessions/${sessionId}/analysis/fes?filename=${filename}`));
}

export async function getEnergy(
  sessionId: string,
  options: { force?: boolean; extract?: boolean; maxPoints?: number } = {},
): Promise<{ data: Record<string, number[]>; available: boolean; has_edr?: boolean; source?: string }> {
  const params = new URLSearchParams();
  if (options.force) params.set("force", "true");
  if (options.extract) params.set("extract", "true");
  params.set("max_points", String(options.maxPoints ?? 5000));
  return json(await authFetch(`${BASE}/sessions/${sessionId}/analysis/energy?${params}`));
}

export interface CVDefinition {
  type: "distance" | "angle" | "dihedral";
  atoms: number[];   // 1-based (PLUMED convention)
  label: string;
}

export interface CustomCVConfig {
  cvs: CVDefinition[];
}

export async function computeCustomCV(
  sessionId: string,
  config: CustomCVConfig,
  force = false,
): Promise<{ data: Record<string, number[] | string[]>; available: boolean }> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}/analysis/custom-cv`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cvs: config.cvs, force }),
  });
  return json(res);
}

export async function getAtomList(
  sessionId: string,
): Promise<{ atoms: { index: number; name: string; element: string; resName: string; resSeq: number }[]; available: boolean }> {
  return json(await authFetch(`${BASE}/sessions/${sessionId}/analysis/atoms`));
}

export async function getMacroCvs(
  sessionId: string,
  macro: string
): Promise<{ cvs: { name: string; type: string; atoms: number[] }[]; count: number }> {
  return json(await authFetch(`${BASE}/sessions/${sessionId}/analysis/macro-cvs?macro=${encodeURIComponent(macro)}`));
}

export async function updateResultCards(sessionId: string, resultCards: unknown[]): Promise<void> {
  await authFetch(`${BASE}/sessions/${sessionId}/result-cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result_cards: resultCards }),
  });
}

// ── Chat messages ────────────────────────────────────────────────────

export async function getMessages(sessionId: string): Promise<{ messages: unknown[] }> {
  return json(await authFetch(`${BASE}/sessions/${sessionId}/messages`));
}

export async function saveMessages(sessionId: string, messages: unknown[]): Promise<void> {
  await authFetch(`${BASE}/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
}

// ── PLUMED ───────────────────────────────────────────────────────────

export async function getPlumedPreview(
  sessionId: string
): Promise<{ content: string | null; method: string; message?: string }> {
  return json(await authFetch(`${BASE}/sessions/${sessionId}/plumed-preview`));
}

export async function generatePlumedFile(
  sessionId: string
): Promise<{ generated: string; work_dir: string }> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}/plumed-generate`, { method: "POST" });
  return json(res);
}

export async function validateCheckpoint(
  sessionId: string,
  filename: string
): Promise<{
  valid: boolean;
  is_jit: boolean;
  n_inputs: number | null;
  n_outputs: number | null;
  error: string | null;
  keys?: string[];
}> {
  const res = await authFetch(
    `${BASE}/sessions/${sessionId}/validate-checkpoint?filename=${encodeURIComponent(filename)}`,
    { method: "POST" }
  );
  return json(res);
}

export async function getProgress(
  sessionId: string,
  filename = "simulation/md.log"
): Promise<{ progress: { step: number; time_ps: number; ns_per_day: number } | null; available: boolean }> {
  return json(await authFetch(`${BASE}/sessions/${sessionId}/analysis/progress?filename=${encodeURIComponent(filename)}`));
}

// ── Molecule library ──────────────────────────────────────────────────

export async function getMolecules(): Promise<{
  systems: { id: string; label: string; states: { name: string; file: string }[] }[];
}> {
  return json(await authFetch(`${BASE}/molecules`));
}

// ── Simulation ────────────────────────────────────────────────────────

export async function startSimulation(
  sessionId: string
): Promise<{ status: string; pid: number; expected_files: Record<string, string> }> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}/simulate`, { method: "POST" });
  return json(res);
}

export async function getSimulationStatus(
  sessionId: string
): Promise<{ running: boolean; status?: "standby" | "running" | "finished" | "failed"; pid?: number; exit_code?: number; started_at?: number; finished_at?: number }> {
  return json(await authFetch(`${BASE}/sessions/${sessionId}/simulate/status`));
}

export async function stopSimulation(sessionId: string): Promise<{ stopped: boolean; has_checkpoint: boolean }> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}/simulate/stop`, { method: "POST" });
  return json(res);
}

export async function checkCheckpoint(sessionId: string): Promise<{ has_checkpoint: boolean }> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}/simulate/checkpoint-status`);
  return json(res);
}

export async function terminateSimulation(sessionId: string): Promise<{ terminated: boolean }> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}/simulate/terminate`, { method: "POST" });
  return json(res);
}

export async function resumeSimulation(
  sessionId: string
): Promise<{ status: string; pid?: number; resumed: boolean; expected_files?: Record<string, string>; message?: string }> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}/simulate/resume`, { method: "POST" });
  return json(res);
}

// ── API keys ──────────────────────────────────────────────────────────

export async function getApiKeys(username: string): Promise<{ keys: Record<string, string> }> {
  return json(await authFetch(`${BASE}/users/${encodeURIComponent(username)}/api-keys`));
}

export async function setApiKey(
  username: string,
  service: string,
  apiKey: string
): Promise<{ updated: boolean }> {
  const res = await authFetch(
    `${BASE}/users/${encodeURIComponent(username)}/api-keys/${encodeURIComponent(service)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey }),
    }
  );
  return json(res);
}

export async function verifyApiKey(
  username: string,
  service: string
): Promise<{ valid: boolean; error: string | null }> {
  const res = await authFetch(
    `${BASE}/users/${encodeURIComponent(username)}/api-keys/${encodeURIComponent(service)}/verify`,
    { method: "POST" }
  );
  return json(res);
}

// ── Server status ────────────────────────────────────────────────────

export interface GpuInfo {
  index: number;
  name: string;
  memory_used_mb: number;
  memory_total_mb: number;
  utilization_pct: number;
  temperature_c: number;
  session_id: string | null;
  session_nickname: string | null;
  available: boolean;
}

export interface ServerStatus {
  cpu: {
    load_1m: number;
    load_5m: number;
    load_15m: number;
    cpu_count: number;
    mem_total_mb: number;
    mem_used_mb: number;
    disk_total_gb?: number;
    disk_used_gb?: number;
  };
  gpus: GpuInfo[];
}

export async function getServerStatus(): Promise<ServerStatus> {
  return json(await authFetch(`${BASE}/server/status`));
}

export async function getAvailableGpu(): Promise<{ gpu_id: string | null; available: boolean }> {
  return json(await authFetch(`${BASE}/server/available-gpu`));
}

// ── Molecules ────────────────────────────────────────────────────────

export async function loadMolecule(
  sessionId: string,
  system: string,
  state: string
): Promise<{ loaded: string; work_dir: string }> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}/molecules/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, state }),
  });
  return json(res);
}
