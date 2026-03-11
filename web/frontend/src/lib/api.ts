import type { ConfigOptions, SessionConfig } from "./types";

const BASE = "/api";

// ── Auth ──────────────────────────────────────────────────────────────

export async function loginUser(
  username: string,
  password: string
): Promise<{ success: boolean; username?: string }> {
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
  const res = await fetch(`${BASE}/sessions`, {
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
  return json(await fetch(`${BASE}/sessions?username=${encodeURIComponent(username)}`));
}

export async function getSessionRunStatus(
  sessionId: string
): Promise<{ run_status: string }> {
  return json(await fetch(`${BASE}/sessions/${sessionId}/run-status`));
}

export async function restoreSession(
  sessionId: string,
  workDir: string,
  nickname = "",
  username = ""
): Promise<void> {
  await fetch(`${BASE}/sessions/${sessionId}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ work_dir: workDir, nickname, username }),
  }).catch(() => {});
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`${BASE}/sessions/${sessionId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
}

export async function updateSessionMolecule(
  sessionId: string,
  selectedMolecule: string
): Promise<{ session_id: string; selected_molecule: string }> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/molecule`, {
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
  const res = await fetch(`${BASE}/sessions/${sessionId}/nickname`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname }),
  });
  return json(res);
}

// ── Config ────────────────────────────────────────────────────────────

export async function getConfigOptions(): Promise<ConfigOptions> {
  return json(await fetch(`${BASE}/config/options`));
}

export async function getSessionConfig(sessionId: string): Promise<{ config: Record<string, unknown> }> {
  return json(await fetch(`${BASE}/sessions/${sessionId}/config`));
}

export async function updateSessionConfig(
  sessionId: string,
  updates: Record<string, unknown>
): Promise<{ updated: boolean }> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  });
  return json(res);
}

export async function generateSessionFiles(
  sessionId: string
): Promise<{ generated: string[]; work_dir: string }> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/generate-files`, {
    method: "POST",
  });
  return json(res);
}

// ── Files ─────────────────────────────────────────────────────────────

export async function listFiles(
  sessionId: string,
  pattern = "*"
): Promise<{ files: string[]; work_dir: string }> {
  return json(await fetch(`${BASE}/sessions/${sessionId}/files?pattern=${encodeURIComponent(pattern)}`));
}

export async function uploadFile(
  sessionId: string,
  file: File
): Promise<{ saved_path: string; size_bytes: number }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/sessions/${sessionId}/files/upload`, {
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
  const res = await fetch(
    `${BASE}/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`,
    { method: "DELETE" }
  );
  return json(res);
}

export async function listArchiveFiles(sessionId: string): Promise<{ files: string[] }> {
  return json(await fetch(`${BASE}/sessions/${sessionId}/files/archive`));
}

export async function restoreFile(sessionId: string, path: string): Promise<{ restored: string }> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/files/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return json(res);
}

export async function getFileContent(sessionId: string, path: string): Promise<string> {
  const res = await fetch(downloadUrl(sessionId, path));
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
  return res.text();
}

// ── Analysis ──────────────────────────────────────────────────────────

export async function getColvar(
  sessionId: string,
  filename = "COLVAR"
): Promise<{ data: Record<string, number[]>; available: boolean }> {
  return json(await fetch(`${BASE}/sessions/${sessionId}/analysis/colvar?filename=${filename}`));
}

export async function getRamachandranData(
  sessionId: string,
  force = false,
): Promise<{ data: { phi: number[]; psi: number[] }; available: boolean }> {
  const qs = force ? "?force=true" : "";
  return json(await fetch(`${BASE}/sessions/${sessionId}/analysis/ramachandran${qs}`));
}

export function getRamachandranImageUrl(sessionId: string, force = false, cacheBust = 0): string {
  const params = new URLSearchParams();
  if (force) params.set("force", "true");
  if (cacheBust) params.set("_t", String(cacheBust));
  const qs = params.size ? `?${params}` : "";
  return `${BASE}/sessions/${sessionId}/analysis/ramachandran.png${qs}`;
}

export async function getFes(
  sessionId: string,
  filename = "fes.dat"
): Promise<{ data: { x: number[]; y: number[]; z: number[][] }; available: boolean }> {
  return json(await fetch(`${BASE}/sessions/${sessionId}/analysis/fes?filename=${filename}`));
}

export async function getEnergy(
  sessionId: string,
  force = false,
): Promise<{ data: Record<string, number[]>; available: boolean }> {
  const qs = force ? "?force=true" : "";
  return json(await fetch(`${BASE}/sessions/${sessionId}/analysis/energy${qs}`));
}

export async function updateResultCards(sessionId: string, resultCards: string[]): Promise<void> {
  await fetch(`${BASE}/sessions/${sessionId}/result-cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result_cards: resultCards }),
  });
}

export async function getProgress(
  sessionId: string,
  filename = "simulation/md.log"
): Promise<{ progress: { step: number; time_ps: number; ns_per_day: number } | null; available: boolean }> {
  return json(await fetch(`${BASE}/sessions/${sessionId}/analysis/progress?filename=${encodeURIComponent(filename)}`));
}

// ── Molecule library ──────────────────────────────────────────────────

export async function getMolecules(): Promise<{
  systems: { id: string; label: string; states: { name: string; file: string }[] }[];
}> {
  return json(await fetch(`${BASE}/molecules`));
}

// ── Simulation ────────────────────────────────────────────────────────

export async function startSimulation(
  sessionId: string
): Promise<{ status: string; pid: number; expected_files: Record<string, string> }> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/simulate`, { method: "POST" });
  return json(res);
}

export async function getSimulationStatus(
  sessionId: string
): Promise<{ running: boolean; status?: "standby" | "running" | "finished" | "failed"; pid?: number; exit_code?: number }> {
  return json(await fetch(`${BASE}/sessions/${sessionId}/simulate/status`));
}

export async function stopSimulation(sessionId: string): Promise<{ stopped: boolean }> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/simulate/stop`, { method: "POST" });
  return json(res);
}

// ── API keys ──────────────────────────────────────────────────────────

export async function getApiKeys(username: string): Promise<{ keys: Record<string, string> }> {
  return json(await fetch(`${BASE}/users/${encodeURIComponent(username)}/api-keys`));
}

export async function setApiKey(
  username: string,
  service: string,
  apiKey: string
): Promise<{ updated: boolean }> {
  const res = await fetch(
    `${BASE}/users/${encodeURIComponent(username)}/api-keys/${encodeURIComponent(service)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey }),
    }
  );
  return json(res);
}

export async function loadMolecule(
  sessionId: string,
  system: string,
  state: string
): Promise<{ loaded: string; work_dir: string }> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/molecules/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, state }),
  });
  return json(res);
}
