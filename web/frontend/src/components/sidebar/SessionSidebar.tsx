"use client";

import { useEffect, useRef, useState } from "react";
import { FlaskConical, Plus, LogOut, Pencil, Check, X, Settings, Trash2, Info, Eye, EyeOff, Loader2, ChevronLeft, ChevronRight, Cpu, RefreshCw, Monitor, HardDrive } from "lucide-react";
import { useSessionStore } from "@/store/sessionStore";
import { logout, getUsername } from "@/lib/auth";
import { updateNickname, restoreSession, deleteSession, getApiKeys, setApiKey, getSessionRunStatus, getServerStatus, type ServerStatus, type GpuInfo } from "@/lib/api";
import { useRouter } from "next/navigation";

interface Props {
  onNewSession: () => void;
  onSelectSession?: (id: string) => void;
  onSessionDeleted?: (id: string) => void;
}

// ── Session list item ──────────────────────────────────────────────────

function statusDotClass(runStatus: string | undefined): string {
  const base = "w-2 h-2 rounded-full flex-shrink-0";
  switch (runStatus) {
    case "running":  return `${base} bg-green-400 animate-pulse`;
    case "paused":   return `${base} bg-amber-400`;
    case "finished": return `${base} bg-blue-400`;
    case "failed":   return `${base} bg-red-500`;
    default:         return `${base} bg-gray-600`;
  }
}

function SessionItem({
  s,
  isActive,
  onSelect,
  onSaved,
  onDeleted,
  onRunStatusRead,
}: {
  s: { session_id: string; work_dir: string; nickname: string; run_status?: string };
  isActive: boolean;
  onSelect: () => void;
  onSaved: (nick: string) => void;
  onDeleted: () => void;
  onRunStatusRead: (runStatus: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const nick = s.nickname || s.work_dir.split("/").pop() || s.session_id.slice(0, 8);
  const [draft, setDraft] = useState(nick);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(nick);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const save = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const trimmed = draft.trim() || nick;
    try {
      await updateNickname(s.session_id, trimmed);
      onSaved(trimmed);
    } catch { /* ignore */ }
    setEditing(false);
  };

  const cancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(false);
  };

  const startConfirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirming(true);
  };

  const confirmDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleting(true);
    try {
      await deleteSession(s.session_id);
      onDeleted();
    } catch { /* ignore */ } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  const cancelConfirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirming(false);
  };

  return (
    <>
      {/* Delete confirmation modal */}
      {confirming && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={cancelConfirm}
        >
          <div
            className="bg-gray-900 border border-red-800/50 rounded-2xl shadow-2xl flex flex-col gap-4 p-6 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-red-900/40 text-red-400 flex-shrink-0">
                <Trash2 size={16} />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-white">Delete session?</h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  <span className="text-gray-300 font-medium">{nick}</span>
                </p>
                <p className="text-xs text-gray-600 mt-1">Output files on disk are kept.</p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={cancelConfirm}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm transition-colors"
              >
                <X size={13} /> Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-white text-sm font-medium disabled:opacity-50 transition-colors"
              >
                <Check size={13} /> {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

    <div
      className={`group relative w-full rounded-lg transition-colors cursor-pointer flex overflow-hidden ${
        isActive ? "bg-gray-800 text-white" : "text-gray-400 hover:bg-gray-800/60 hover:text-gray-200"
      }`}
    >
      {/* Main content — clickable to select */}
      <div
        className="flex-1 min-w-0 px-3 py-2.5"
        onClick={() => {
          if (editing || confirming) return;
          // Select immediately so workspace shows loading skeleton
          onSelect();
          // Restore session & fetch run status in background
          restoreSession(s.session_id, s.work_dir, s.nickname).catch(() => {});
          getSessionRunStatus(s.session_id)
            .then(({ run_status }) => onRunStatusRead(run_status))
            .catch(() => {});
        }}
      >
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className={statusDotClass(s.run_status)} />
          {editing ? (
            <div className="flex items-center gap-1 flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") save();
                  if (e.key === "Escape") setEditing(false);
                }}
                autoFocus
                className="flex-1 min-w-0 text-xs bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button onClick={save} className="text-emerald-400 hover:text-emerald-300 flex-shrink-0">
                <Check size={11} />
              </button>
              <button onClick={cancel} className="text-gray-500 hover:text-gray-400 flex-shrink-0">
                <X size={11} />
              </button>
            </div>
          ) : (
            <span className="text-xs font-medium truncate flex-1">
              {nick}
            </span>
          )}
        </div>
        {!editing && (
          <div className="pl-3 text-[10px] text-gray-600 font-mono truncate">{s.session_id.slice(0, 8)}…</div>
        )}
      </div>

      {/* Full-height action buttons — visible on hover */}
      {!editing && (
        <div className="opacity-0 group-hover:opacity-100 flex flex-shrink-0 transition-opacity border-l border-gray-700/40">
          <button
            onClick={startEdit}
            className="flex items-center justify-center w-7 text-gray-600 hover:text-gray-300 hover:bg-gray-700/30 transition-colors"
            title="Rename"
          >
            <Pencil size={10} />
          </button>
          <button
            onClick={startConfirm}
            className="flex items-center justify-center w-7 text-gray-600 hover:text-red-400 hover:bg-red-900/20 transition-colors border-l border-gray-700/40"
            title="Delete"
          >
            <Trash2 size={10} />
          </button>
        </div>
      )}
    </div>
    </>
  );
}

// ── Information modal ──────────────────────────────────────────────────

function InformationModal({ username, onClose }: { username: string; onClose: () => void }) {
  const [wandbKey, setWandbKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getApiKeys(username).then(({ keys }) => {
      setWandbKey(keys["wandb"] ?? "");
    });
  }, [username]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await setApiKey(username, "wandb", wandbKey);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-[380px] bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Info size={15} className="text-indigo-400" />
            <span className="text-sm font-semibold text-gray-100">Account Information</span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-5">
          {/* User info */}
          <div className="flex items-center gap-3 pb-3 border-b border-gray-800">
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white text-sm font-semibold shadow">
              {username[0]?.toUpperCase() ?? "?"}
            </div>
            <div>
              <div className="text-sm font-medium text-gray-100">{username}</div>
              <div className="text-[10px] text-gray-500">Signed in</div>
            </div>
          </div>

          {/* API Keys section */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">API Keys</h4>

            {/* WandB */}
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-xs font-medium text-gray-300">
                <span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" />
                Weights & Biases (WandB)
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type={showKey ? "text" : "password"}
                    value={wandbKey}
                    onChange={(e) => setWandbKey(e.target.value)}
                    placeholder="Enter WandB API key"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-100 placeholder-gray-600 focus:outline-none focus:border-indigo-500 pr-8"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                </div>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-3 py-2 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white transition-colors"
                >
                  {saved ? <Check size={12} /> : saving ? "…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Server Status Modal ───────────────────────────────────────────────

function GpuCard({ gpu }: { gpu: GpuInfo }) {
  const memPct = gpu.memory_total_mb > 0 ? (gpu.memory_used_mb / gpu.memory_total_mb) * 100 : 0;
  const isIdle = gpu.available;
  const statusColor = gpu.session_id ? "text-blue-400" : isIdle ? "text-emerald-400" : "text-amber-400";
  const statusLabel = gpu.session_id
    ? gpu.session_nickname || gpu.session_id.slice(0, 8)
    : isIdle ? "Available" : "In use (external)";

  return (
    <div className="bg-gray-800/60 border border-gray-700/50 rounded-lg p-3.5 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono font-semibold text-gray-300">GPU {gpu.index}</span>
          <span className="text-xs text-gray-500">{gpu.name}</span>
        </div>
        <span className={`text-xs font-medium ${statusColor}`}>{statusLabel}</span>
      </div>
      {/* Utilization bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-500">
          <span>Util {gpu.utilization_pct}%</span>
          <span>{gpu.temperature_c}°C</span>
        </div>
        <div className="h-2 bg-gray-900 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${gpu.utilization_pct > 80 ? "bg-red-500" : gpu.utilization_pct > 40 ? "bg-amber-500" : "bg-emerald-500"}`}
            style={{ width: `${gpu.utilization_pct}%` }}
          />
        </div>
      </div>
      {/* Memory bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-500">
          <span>VRAM</span>
          <span>{(gpu.memory_used_mb / 1024).toFixed(1)} / {(gpu.memory_total_mb / 1024).toFixed(1)} GB</span>
        </div>
        <div className="h-2 bg-gray-900 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${memPct > 80 ? "bg-red-500" : memPct > 40 ? "bg-amber-500" : "bg-emerald-500/60"}`}
            style={{ width: `${memPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function ServerStatusModal({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = (isManual = false) => {
    if (isManual) setRefreshing(true);
    getServerStatus()
      .then((s) => { setStatus(s); setError(null); })
      .catch((e) => { setError(e?.message ?? "Failed to fetch server status"); })
      .finally(() => { setLoading(false); setRefreshing(false); });
  };

  useEffect(() => {
    fetchStatus();
    intervalRef.current = setInterval(() => fetchStatus(), 5000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  // Esc to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const cpu = status?.cpu;
  const gpus = status?.gpus ?? [];
  const memPct = cpu ? (cpu.mem_used_mb / cpu.mem_total_mb) * 100 : 0;
  const diskPct = cpu?.disk_total_gb ? ((cpu.disk_used_gb ?? 0) / cpu.disk_total_gb) * 100 : 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[520px] max-h-[85vh] bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Monitor size={16} className="text-emerald-400" />
            <span className="text-sm font-semibold text-gray-100">Server Status</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => fetchStatus(true)}
              className="p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-700 transition-colors"
              title="Refresh"
            >
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-700 transition-colors">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-gray-500" />
            </div>
          ) : error && !status ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <p className="text-sm text-red-400">Failed to load server status</p>
              <p className="text-xs text-gray-500">{error}</p>
              <button
                onClick={() => fetchStatus(true)}
                className="px-3 py-1.5 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              {/* CPU & Memory */}
              {cpu && (
                <div className="space-y-3">
                  <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Cpu size={13} /> CPU & Memory
                  </h4>
                  <div className="bg-gray-800/60 border border-gray-700/50 rounded-lg p-3.5 space-y-3">
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <p className="text-xs text-gray-500 uppercase">Load (1m)</p>
                        <p className="text-sm font-mono text-gray-200">{cpu.load_1m.toFixed(2)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 uppercase">Cores</p>
                        <p className="text-sm font-mono text-gray-200">{cpu.cpu_count}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 uppercase">Load %</p>
                        <p className="text-sm font-mono text-gray-200">{((cpu.load_1m / cpu.cpu_count) * 100).toFixed(0)}%</p>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs text-gray-500">
                        <span>Memory</span>
                        <span>{(cpu.mem_used_mb / 1024).toFixed(1)} / {(cpu.mem_total_mb / 1024).toFixed(1)} GB</span>
                      </div>
                      <div className="h-2 bg-gray-900 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${memPct > 80 ? "bg-red-500" : memPct > 60 ? "bg-amber-500" : "bg-emerald-500/60"}`}
                          style={{ width: `${memPct}%` }}
                        />
                      </div>
                    </div>
                    {cpu.disk_total_gb != null && (
                      <div className="space-y-1">
                        <div className="flex justify-between text-xs text-gray-500">
                          <span className="flex items-center gap-1"><HardDrive size={10} /> Storage</span>
                          <span>{(cpu.disk_used_gb ?? 0).toFixed(1)} / {cpu.disk_total_gb.toFixed(1)} GB</span>
                        </div>
                        <div className="h-2 bg-gray-900 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${diskPct > 90 ? "bg-red-500" : diskPct > 75 ? "bg-amber-500" : "bg-blue-500/60"}`}
                            style={{ width: `${diskPct}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* GPUs */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                  <span className="w-3.5 h-3.5 rounded bg-emerald-500/20 flex items-center justify-center text-[9px] text-emerald-400 font-bold">G</span>
                  GPUs ({gpus.length})
                  <span className="ml-auto text-xs font-normal text-gray-600">
                    {gpus.filter(g => g.available).length} available
                  </span>
                </h4>
                <div className="space-y-2">
                  {gpus.map((gpu) => <GpuCard key={gpu.index} gpu={gpu} />)}
                  {gpus.length === 0 && (
                    <p className="text-sm text-gray-600 py-3">No GPUs detected — restart the server if nvidia-smi is available.</p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2.5 border-t border-gray-800 flex-shrink-0">
          <p className="text-xs text-gray-600 text-center">Auto-refreshes every 5 seconds</p>
        </div>
      </div>
    </div>
  );
}

// ── Profile section ────────────────────────────────────────────────────

function ProfileSection({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [serverStatusOpen, setServerStatusOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const initial = username ? username[0].toUpperCase() : "?";

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative px-3 py-3 border-t border-gray-800 flex-shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-gray-800 transition-colors group"
      >
        {/* Avatar */}
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center flex-shrink-0 text-white text-xs font-semibold shadow">
          {initial}
        </div>
        {/* Name */}
        <span className="flex-1 text-left text-xs font-medium text-gray-300 truncate group-hover:text-white transition-colors">
          {username}
        </span>
        {/* Dots */}
        <Settings size={15} className="text-gray-600 group-hover:text-gray-400 flex-shrink-0 transition-colors" />
      </button>

      {/* Popover menu */}
      {open && (
        <div className="absolute bottom-full left-3 right-3 mb-1 bg-gray-800 border border-gray-700 rounded-xl shadow-xl overflow-hidden z-50">
          {/* User info header */}
          <div className="flex items-center gap-2.5 px-3 py-3 border-b border-gray-700">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center flex-shrink-0 text-white text-sm font-semibold shadow">
              {initial}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white truncate">{username}</div>
              <div className="text-[11px] text-gray-500">Signed in</div>
            </div>
          </div>
          {/* Actions */}
          <button
            onClick={() => { setOpen(false); setServerStatusOpen(true); }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-gray-400 hover:text-gray-100 hover:bg-gray-700/60 transition-colors"
          >
            <Monitor size={14} />
            Server Status
          </button>
          <button
            onClick={() => { setOpen(false); setInfoOpen(true); }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-gray-400 hover:text-gray-100 hover:bg-gray-700/60 transition-colors"
          >
            <Info size={14} />
            Information
          </button>
          <button
            onClick={() => { setOpen(false); onLogout(); }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-gray-400 hover:text-red-400 hover:bg-gray-700/60 transition-colors"
          >
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      )}

      {infoOpen && (
        <InformationModal username={username} onClose={() => setInfoOpen(false)} />
      )}
      {serverStatusOpen && (
        <ServerStatusModal onClose={() => setServerStatusOpen(false)} />
      )}
    </div>
  );
}

// ── Main sidebar ───────────────────────────────────────────────────────

export default function SessionSidebar({ onNewSession, onSelectSession, onSessionDeleted }: Props) {
  const router = useRouter();
  const { sessions, sessionsLoading, sessionId, fetchSessions, switchSession, updateSessionNickname, removeSession, setSessionRunStatus } =
    useSessionStore();
  const username = getUsername();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleLogout = () => {
    logout();
    router.push("/login");
  };

  if (collapsed) {
    return (
      <aside className="w-10 flex-shrink-0 bg-gray-950 border-r border-gray-800 flex flex-col h-full overflow-x-hidden transition-all duration-200">
        <button
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
          className="flex-1 flex flex-col items-center justify-center gap-3 text-gray-600 hover:text-gray-300 transition-colors"
        >
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow">
            <FlaskConical size={12} className="text-white" />
          </div>
          <ChevronRight size={15} />
          <span
            className="text-[10px] font-semibold uppercase tracking-widest text-gray-600"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            Sessions
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-56 flex-shrink-0 bg-gray-950 border-r border-gray-800 flex flex-col h-full transition-all duration-200">
      {/* Brand */}
      <div className="px-4 py-4 border-b border-gray-800 flex items-center gap-2.5 flex-shrink-0">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow">
          <FlaskConical size={16} className="text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-white leading-tight">AMD</div>
          <div className="text-[11px] text-gray-500">Ahn MD</div>
        </div>
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse sidebar"
          className="p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-700 transition-colors flex-shrink-0"
        >
          <ChevronLeft size={15} />
        </button>
      </div>

      {/* New session button */}
      <div className="px-3 py-2.5 flex-shrink-0">
        <button
          onClick={onNewSession}
          className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:bg-gray-800 hover:text-white transition-colors border border-gray-800 hover:border-gray-700"
        >
          <Plus size={12} />
          <span className="text-xs font-medium">New Session</span>
        </button>
      </div>

      {/* Sessions list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sessionsLoading && sessions.length === 0 ? (
          <div className="px-1 py-2">
            <div className="flex items-center gap-2 px-2 mb-3">
              <Loader2 size={11} className="animate-spin text-gray-600" />
              <span className="text-[11px] text-gray-600">Loading sessions…</span>
            </div>
            <div className="space-y-1 animate-pulse">
              {[1, 2, 3].map((i) => (
                <div key={i} className="rounded-lg bg-gray-800/60 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <div className="w-2 h-2 rounded-full bg-gray-700" />
                    <div className="h-3 w-24 bg-gray-700 rounded" />
                  </div>
                  <div className="pl-3 h-2.5 w-16 bg-gray-800 rounded" />
                </div>
              ))}
            </div>
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-[11px] text-gray-600 px-3 py-2">No sessions yet</p>
        ) : (
          <div className="space-y-0.5">
            {sessions.map((s) => (
              <SessionItem
                key={s.session_id}
                s={s}
                isActive={s.session_id === sessionId}
                onSelect={() => { switchSession(s.session_id, s.work_dir); onSelectSession?.(s.session_id); }}
                onSaved={(nick) => updateSessionNickname(s.session_id, nick)}
                onDeleted={() => { removeSession(s.session_id); onSessionDeleted?.(s.session_id); }}
                onRunStatusRead={(rs) => setSessionRunStatus(s.session_id, rs as "standby" | "running" | "finished" | "failed")}
              />
            ))}
          </div>
        )}
      </div>

      <ProfileSection username={username ?? "user"} onLogout={handleLogout} />
    </aside>
  );
}
