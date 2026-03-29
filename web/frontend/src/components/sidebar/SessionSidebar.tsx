"use client";

import { useEffect, useRef, useState } from "react";
import { FlaskConical, Plus, LogOut, Pencil, Check, X, Settings, Trash2, Eye, EyeOff, Loader2, ChevronLeft, ChevronRight, Cpu, RefreshCw, Monitor, HardDrive, Sun, Moon, Bot, CircleCheck, CircleX } from "lucide-react";
import { useSessionStore } from "@/store/sessionStore";
import { logout, getUsername } from "@/lib/auth";
import { updateNickname, restoreSession, deleteSession, getApiKeys, setApiKey, verifyApiKey, getSessionRunStatus, getServerStatus, type ServerStatus, type GpuInfo } from "@/lib/api";
import { useRouter } from "next/navigation";
import { useTheme } from "@/lib/theme";


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
    default:         return `${base} bg-gray-400 dark:bg-gray-600`;
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
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={cancelConfirm}
        >
          <div
            className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl flex flex-col gap-4 p-6 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-red-100 dark:bg-red-900/40 text-red-500 dark:text-red-400 flex-shrink-0">
                <Trash2 size={16} />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Delete session?</h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  <span className="text-gray-700 dark:text-gray-300 font-medium">{nick}</span>
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-600 mt-1">Output files on disk are kept.</p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={cancelConfirm}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 text-sm transition-colors"
              >
                <X size={13} /> Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium disabled:opacity-50 transition-colors"
              >
                <Check size={13} /> {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

    <div
      className={`group relative w-full rounded-lg transition-colors cursor-pointer flex overflow-hidden ${
        isActive
          ? "bg-blue-50 dark:bg-gray-800 text-blue-700 dark:text-white"
          : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800/60 hover:text-gray-900 dark:hover:text-gray-200"
      }`}
    >
      {/* Main content — clickable to select */}
      <div
        className="flex-1 min-w-0 px-3 py-2.5"
        onClick={() => {
          if (editing || confirming) return;
          onSelect();
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
                className="flex-1 min-w-0 text-xs bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-1.5 py-0.5 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button onClick={save} className="text-emerald-500 hover:text-emerald-400 flex-shrink-0">
                <Check size={11} />
              </button>
              <button onClick={cancel} className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-400 flex-shrink-0">
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
          <div className="pl-3 text-[10px] text-gray-400 dark:text-gray-600 font-mono truncate">{s.session_id.slice(0, 8)}…</div>
        )}
      </div>

      {/* Full-height action buttons — visible on hover */}
      {!editing && (
        <div className="opacity-0 group-hover:opacity-100 flex flex-shrink-0 transition-opacity border-l border-gray-200/60 dark:border-gray-700/40">
          <button
            onClick={startEdit}
            className="flex items-center justify-center w-7 text-gray-400 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/30 transition-colors"
            title="Rename"
          >
            <Pencil size={10} />
          </button>
          <button
            onClick={startConfirm}
            className="flex items-center justify-center w-7 text-gray-400 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors border-l border-gray-200/60 dark:border-gray-700/40"
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

// ── Settings modal ──────────────────────────────────────────────────

function ApiKeyRow({
  label,
  color,
  value,
  onChange,
  placeholder,
  onSave,
  saving,
  saved,
  verified,
  verifying,
  onVerify,
}: {
  label: string;
  color: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  verified: boolean | null;
  verifying: boolean;
  onVerify: () => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 w-[72px] flex-shrink-0">
        <span className={`w-2 h-2 rounded-full ${color} inline-block flex-shrink-0`} />
        <span className="truncate">{label}</span>
      </label>
      <div className="relative flex-1 min-w-0">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 pr-7 transition-colors"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors"
        >
          {show ? <EyeOff size={11} /> : <Eye size={11} />}
        </button>
      </div>
      <button
        onClick={async () => { await onSave(); onVerify(); }}
        disabled={saving || !value}
        className="px-2 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors flex-shrink-0"
      >
        {saved ? <Check size={12} /> : saving ? "…" : "Save"}
      </button>
      {verified !== null ? (
        <span className={`flex-shrink-0 ${verified ? "text-emerald-500" : "text-red-400"}`} title={verified ? "Verified" : "Invalid"}>
          {verified ? <CircleCheck size={14} /> : <CircleX size={14} />}
        </span>
      ) : verifying ? (
        <Loader2 size={14} className="animate-spin text-gray-400 flex-shrink-0" />
      ) : (
        <span className="w-[14px] flex-shrink-0" />
      )}
    </div>
  );
}

const AGENT_BACKENDS = [
  { id: "anthropic", label: "Claude", color: "orange" },
  { id: "openai",    label: "ChatGPT", color: "emerald" },
  { id: "deepseek",  label: "DeepSeek", color: "blue" },
] as const;

type AgentBackendId = typeof AGENT_BACKENDS[number]["id"];

function SettingsModal({ username, onClose }: { username: string; onClose: () => void }) {
  const { theme, toggle } = useTheme();

  // API keys state
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [verified, setVerified] = useState<Record<string, boolean | null>>({});
  const [verifying, setVerifying] = useState<Record<string, boolean>>({});

  // Agent backbone
  const [agentBackend, setAgentBackend] = useState<AgentBackendId>("anthropic");

  useEffect(() => {
    getApiKeys(username).then(({ keys: k }) => {
      setKeys(k);
      // Auto-verify stored keys
      for (const svc of ["anthropic", "openai", "deepseek", "wandb"]) {
        if (k[svc]) {
          setVerifying((v) => ({ ...v, [svc]: true }));
          verifyApiKey(username, svc)
            .then((res) => setVerified((v) => ({ ...v, [svc]: res.valid })))
            .catch(() => setVerified((v) => ({ ...v, [svc]: false })))
            .finally(() => setVerifying((v) => ({ ...v, [svc]: false })));
        }
      }
      // Restore agent backend preference
      if (k["_agent_backend"]) setAgentBackend(k["_agent_backend"] as AgentBackendId);
    });
  }, [username]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleSaveKey = async (service: string) => {
    setSaving((s) => ({ ...s, [service]: true }));
    try {
      await setApiKey(username, service, keys[service] ?? "");
      setSaved((s) => ({ ...s, [service]: true }));
      setTimeout(() => setSaved((s) => ({ ...s, [service]: false })), 2000);
    } finally {
      setSaving((s) => ({ ...s, [service]: false }));
    }
  };

  const handleVerify = async (service: string) => {
    setVerifying((v) => ({ ...v, [service]: true }));
    setVerified((v) => ({ ...v, [service]: null }));
    try {
      const res = await verifyApiKey(username, service);
      setVerified((v) => ({ ...v, [service]: res.valid }));
    } catch {
      setVerified((v) => ({ ...v, [service]: false }));
    } finally {
      setVerifying((v) => ({ ...v, [service]: false }));
    }
  };

  const handleSetBackend = async (id: AgentBackendId) => {
    setAgentBackend(id);
    await setApiKey(username, "_agent_backend", id);
  };

  const setKeyValue = (service: string, value: string) => {
    setKeys((k) => ({ ...k, [service]: value }));
    setVerified((v) => ({ ...v, [service]: null }));
  };

  const gmxImage = "gromacs-plumed:latest";
  const sysVersion = "0.1.0";

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-[420px] max-h-[90vh] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-gray-100 dark:bg-gray-800">
              <Settings size={15} className="text-gray-500 dark:text-gray-400" />
            </div>
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Settings</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6" style={{ scrollbarWidth: "thin" }}>

          {/* ── Account ── */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Account</h4>
            <div className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700/50">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white text-sm font-semibold shadow">
                {username[0]?.toUpperCase() ?? "?"}
              </div>
              <div>
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{username}</div>
                <div className="text-[10px] text-gray-400 dark:text-gray-500">Signed in</div>
              </div>
            </div>
          </div>

          {/* ── API Keys ── */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">API Keys</h4>
            <ApiKeyRow
              label="Anthropic Claude"
              color="bg-orange-400"
              value={keys["anthropic"] ?? ""}
              onChange={(v) => setKeyValue("anthropic", v)}
              placeholder="sk-ant-..."
              onSave={() => handleSaveKey("anthropic")}
              saving={saving["anthropic"] ?? false}
              saved={saved["anthropic"] ?? false}
              verified={verified["anthropic"] ?? null}
              verifying={verifying["anthropic"] ?? false}
              onVerify={() => handleVerify("anthropic")}
            />
            <ApiKeyRow
              label="OpenAI ChatGPT"
              color="bg-emerald-400"
              value={keys["openai"] ?? ""}
              onChange={(v) => setKeyValue("openai", v)}
              placeholder="sk-..."
              onSave={() => handleSaveKey("openai")}
              saving={saving["openai"] ?? false}
              saved={saved["openai"] ?? false}
              verified={verified["openai"] ?? null}
              verifying={verifying["openai"] ?? false}
              onVerify={() => handleVerify("openai")}
            />
            <ApiKeyRow
              label="DeepSeek"
              color="bg-blue-400"
              value={keys["deepseek"] ?? ""}
              onChange={(v) => setKeyValue("deepseek", v)}
              placeholder="sk-..."
              onSave={() => handleSaveKey("deepseek")}
              saving={saving["deepseek"] ?? false}
              saved={saved["deepseek"] ?? false}
              verified={verified["deepseek"] ?? null}
              verifying={verifying["deepseek"] ?? false}
              onVerify={() => handleVerify("deepseek")}
            />
            <ApiKeyRow
              label="Weights & Biases"
              color="bg-yellow-400"
              value={keys["wandb"] ?? ""}
              onChange={(v) => setKeyValue("wandb", v)}
              placeholder="Enter WandB API key"
              onSave={() => handleSaveKey("wandb")}
              saving={saving["wandb"] ?? false}
              saved={saved["wandb"] ?? false}
              verified={verified["wandb"] ?? null}
              verifying={verifying["wandb"] ?? false}
              onVerify={() => handleVerify("wandb")}
            />
          </div>

          {/* ── Agent Backbone ── */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Agent Backbone</h4>
            <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden h-[36px]">
              {AGENT_BACKENDS.map((b, i) => {
                const isVerified = verified[b.id] === true;
                const isActive = agentBackend === b.id;
                const disabled = !isVerified;
                return (
                  <button
                    key={b.id}
                    onClick={() => !disabled && handleSetBackend(b.id)}
                    disabled={disabled}
                    title={disabled ? `Add and verify your ${b.label} API key first` : `Use ${b.label} as agent backbone`}
                    className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-medium transition-colors ${
                      isActive && !disabled
                        ? b.color === "orange"
                          ? "bg-orange-100/60 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400"
                          : b.color === "emerald"
                            ? "bg-emerald-100/60 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400"
                            : "bg-blue-100/60 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
                        : disabled
                          ? "bg-gray-50 dark:bg-gray-800/40 text-gray-300 dark:text-gray-600 cursor-not-allowed"
                          : "bg-gray-50 dark:bg-gray-800/40 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                    } ${i < AGENT_BACKENDS.length - 1 ? "border-r border-gray-200 dark:border-gray-700" : ""}`}
                  >
                    <Bot size={11} />
                    {b.label}
                    {isActive && !disabled && <Check size={10} />}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-gray-400 dark:text-gray-600">
              Only providers with a verified API key can be selected.
            </p>
          </div>

          {/* ── System Info ── */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">System</h4>
            <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700/50 divide-y divide-gray-100 dark:divide-gray-800">
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="text-xs text-gray-500 dark:text-gray-400">Version</span>
                <span className="text-xs font-mono text-gray-700 dark:text-gray-300">{sysVersion}</span>
              </div>
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="text-xs text-gray-500 dark:text-gray-400">GROMACS</span>
                <span className="text-xs font-mono text-gray-700 dark:text-gray-300">{gmxImage}</span>
              </div>
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="text-xs text-gray-500 dark:text-gray-400">Agent</span>
                <span className="text-xs font-mono text-gray-700 dark:text-gray-300">
                  {AGENT_BACKENDS.find((b) => b.id === agentBackend)?.label ?? "Claude"}
                </span>
              </div>
            </div>
          </div>

          {/* ── Appearance ── */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Appearance</h4>
            <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700/50">
              <div className="flex items-center gap-2.5">
                {theme === "dark" ? <Moon size={15} className="text-indigo-400" /> : <Sun size={15} className="text-amber-500" />}
                <span className="text-sm text-gray-700 dark:text-gray-300">{theme === "dark" ? "Dark" : "Light"} mode</span>
              </div>
              <button
                onClick={toggle}
                className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
                  theme === "dark" ? "bg-indigo-600" : "bg-gray-300"
                }`}
              >
                <span
                  className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-[left] duration-200"
                  style={{ left: theme === "dark" ? "22px" : "2px" }}
                />
              </button>
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
  const statusColor = gpu.session_id ? "text-blue-500" : isIdle ? "text-emerald-500" : "text-amber-500";
  const statusLabel = gpu.session_id
    ? gpu.session_nickname || gpu.session_id.slice(0, 8)
    : isIdle ? "Available" : "In use (external)";

  return (
    <div className="bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700/50 rounded-lg p-3.5 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono font-semibold text-gray-700 dark:text-gray-300">GPU {gpu.index}</span>
          <span className="text-xs text-gray-400 dark:text-gray-500">{gpu.name}</span>
        </div>
        <span className={`text-xs font-medium ${statusColor}`}>{statusLabel}</span>
      </div>
      {/* Utilization bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500">
          <span>Util {gpu.utilization_pct}%</span>
          <span>{gpu.temperature_c}°C</span>
        </div>
        <div className="h-2 bg-gray-200 dark:bg-gray-900 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${gpu.utilization_pct > 80 ? "bg-red-500" : gpu.utilization_pct > 40 ? "bg-amber-500" : "bg-emerald-500"}`}
            style={{ width: `${gpu.utilization_pct}%` }}
          />
        </div>
      </div>
      {/* Memory bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500">
          <span>VRAM</span>
          <span>{(gpu.memory_used_mb / 1024).toFixed(1)} / {(gpu.memory_total_mb / 1024).toFixed(1)} GB</span>
        </div>
        <div className="h-2 bg-gray-200 dark:bg-gray-900 rounded-full overflow-hidden">
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
    <div className="fixed inset-0 z-60 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[520px] max-h-[85vh] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Monitor size={16} className="text-emerald-500" />
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Server Status</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => fetchStatus(true)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title="Refresh"
            >
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-gray-400" />
            </div>
          ) : error && !status ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <p className="text-sm text-red-500">Failed to load server status</p>
              <p className="text-xs text-gray-400">{error}</p>
              <button
                onClick={() => fetchStatus(true)}
                className="px-3 py-1.5 rounded-lg text-xs bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors"
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              {/* CPU & Memory */}
              {cpu && (
                <div className="space-y-3">
                  <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Cpu size={13} /> CPU & Memory
                  </h4>
                  <div className="bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700/50 rounded-lg p-3.5 space-y-3">
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <p className="text-xs text-gray-400 dark:text-gray-500 uppercase">Load (1m)</p>
                        <p className="text-sm font-mono text-gray-700 dark:text-gray-200">{cpu.load_1m.toFixed(2)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 dark:text-gray-500 uppercase">Cores</p>
                        <p className="text-sm font-mono text-gray-700 dark:text-gray-200">{cpu.cpu_count}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 dark:text-gray-500 uppercase">Load %</p>
                        <p className="text-sm font-mono text-gray-700 dark:text-gray-200">{((cpu.load_1m / cpu.cpu_count) * 100).toFixed(0)}%</p>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500">
                        <span>Memory</span>
                        <span>{(cpu.mem_used_mb / 1024).toFixed(1)} / {(cpu.mem_total_mb / 1024).toFixed(1)} GB</span>
                      </div>
                      <div className="h-2 bg-gray-200 dark:bg-gray-900 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${memPct > 80 ? "bg-red-500" : memPct > 60 ? "bg-amber-500" : "bg-emerald-500/60"}`}
                          style={{ width: `${memPct}%` }}
                        />
                      </div>
                    </div>
                    {cpu.disk_total_gb != null && (
                      <div className="space-y-1">
                        <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500">
                          <span className="flex items-center gap-1"><HardDrive size={10} /> Storage</span>
                          <span>{(cpu.disk_used_gb ?? 0).toFixed(1)} / {cpu.disk_total_gb.toFixed(1)} GB</span>
                        </div>
                        <div className="h-2 bg-gray-200 dark:bg-gray-900 rounded-full overflow-hidden">
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
                <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                  <span className="w-3.5 h-3.5 rounded bg-emerald-500/20 flex items-center justify-center text-[9px] text-emerald-500 font-bold">G</span>
                  GPUs ({gpus.length})
                  <span className="ml-auto text-xs font-normal text-gray-400 dark:text-gray-600">
                    {gpus.filter(g => g.available).length} available
                  </span>
                </h4>
                <div className="space-y-2">
                  {gpus.map((gpu) => <GpuCard key={gpu.index} gpu={gpu} />)}
                  {gpus.length === 0 && (
                    <p className="text-sm text-gray-400 dark:text-gray-600 py-3">No GPUs detected.</p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2.5 border-t border-gray-100 dark:border-gray-800 flex-shrink-0">
          <p className="text-xs text-gray-400 dark:text-gray-600 text-center">Auto-refreshes every 5 seconds</p>
        </div>
      </div>
    </div>
  );
}

// ── Profile section (with larger settings button) ───────────────────

function ProfileSection({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverStatusOpen, setServerStatusOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const initial = username ? username[0].toUpperCase() : "?";

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative px-3 border-t border-gray-200 dark:border-gray-800 flex-shrink-0 h-[72px] flex items-center w-full">
      {/* Larger settings trigger */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors group"
      >
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center flex-shrink-0 text-white text-sm font-semibold shadow">
          {initial}
        </div>
        <span className="flex-1 text-left text-sm font-medium text-gray-700 dark:text-gray-300 truncate group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
          {username}
        </span>
        <Settings size={18} className="text-gray-400 dark:text-gray-600 group-hover:text-gray-600 dark:group-hover:text-gray-400 flex-shrink-0 transition-colors" />
      </button>

      {/* Popover menu */}
      {open && (
        <div className="absolute bottom-full left-3 right-3 mb-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl overflow-hidden z-50">
          <button
            onClick={() => { setOpen(false); setServerStatusOpen(true); }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-700/60 transition-colors"
          >
            <Monitor size={15} />
            Server Status
          </button>
          <button
            onClick={() => { setOpen(false); setSettingsOpen(true); }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-700/60 transition-colors"
          >
            <Settings size={15} />
            Settings
          </button>
          <div className="border-t border-gray-100 dark:border-gray-700" />
          <button
            onClick={() => { setOpen(false); onLogout(); }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-600 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-50 dark:hover:bg-gray-700/60 transition-colors"
          >
            <LogOut size={15} />
            Sign out
          </button>
        </div>
      )}

      {settingsOpen && (
        <SettingsModal username={username} onClose={() => setSettingsOpen(false)} />
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
      <aside className="w-10 flex-shrink-0 bg-white dark:bg-gray-950 border-r border-gray-200 dark:border-gray-800 flex flex-col h-full overflow-x-hidden transition-all duration-200">
        <button
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
          className="flex-1 flex flex-col items-center justify-center gap-3 text-gray-400 hover:text-gray-700 dark:text-gray-600 dark:hover:text-gray-300 transition-colors"
        >
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow">
            <FlaskConical size={12} className="text-white" />
          </div>
          <ChevronRight size={15} />
          <span
            className="text-[10px] font-semibold uppercase tracking-widest"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            Sessions
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-64 flex-shrink-0 bg-white dark:bg-gray-950 border-r border-gray-200 dark:border-gray-800 flex flex-col h-full transition-all duration-200">
      {/* Brand */}
      <div className="px-4 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center gap-2.5 flex-shrink-0">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow">
          <FlaskConical size={16} className="text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-900 dark:text-white leading-tight">AMD</div>
          <div className="text-[11px] text-gray-400 dark:text-gray-500">Ahn MD</div>
        </div>
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse sidebar"
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex-shrink-0"
        >
          <ChevronLeft size={15} />
        </button>
      </div>

      {/* New session button */}
      <div className="px-3 py-2.5 flex-shrink-0">
        <button
          onClick={onNewSession}
          className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white transition-colors border border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700"
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
              <Loader2 size={11} className="animate-spin text-gray-400" />
              <span className="text-[11px] text-gray-400 dark:text-gray-600">Loading sessions…</span>
            </div>
            <div className="space-y-1 animate-pulse">
              {[1, 2, 3].map((i) => (
                <div key={i} className="rounded-lg bg-gray-100 dark:bg-gray-800/60 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <div className="w-2 h-2 rounded-full bg-gray-200 dark:bg-gray-700" />
                    <div className="h-3 w-24 bg-gray-200 dark:bg-gray-700 rounded" />
                  </div>
                  <div className="pl-3 h-2.5 w-16 bg-gray-100 dark:bg-gray-800 rounded" />
                </div>
              ))}
            </div>
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-[11px] text-gray-400 dark:text-gray-600 px-3 py-2">No sessions yet</p>
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
