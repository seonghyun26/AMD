"use client";

import { useEffect, useRef, useState } from "react";
import { FlaskConical, Plus, LogOut, Pencil, Check, X, Settings, Trash2, Eye, EyeOff, Loader2, ChevronLeft, ChevronRight, Cpu, RefreshCw, Monitor, HardDrive, Sun, Moon, Bot, CircleCheck, CircleX, FolderOpen, FolderPlus, ArrowLeft, Upload, Info } from "lucide-react";
import { useSessionStore, type SessionSummary } from "@/store/sessionStore";
import { useProjectStore } from "@/store/projectStore";
import { logout, getUsername } from "@/lib/auth";
import { updateNickname, restoreSession, deleteSession, getApiKeys, setApiKey, verifyApiKey, getSessionRunStatus, getServerStatus, uploadAvatar, deleteAvatar, type ServerStatus, type GpuInfo } from "@/lib/api";
import UserAvatar from "@/components/common/UserAvatar";
import PopupPresence from "@/components/ui/PopupPresence";
import PopupTailClose from "@/components/ui/PopupTailClose";
import { useRouter } from "next/navigation";
import { useTheme } from "@/lib/theme";


interface Props {
  onNewSession: () => void;
  onSelectSession?: (id: string | null) => void;
  onSessionDeleted?: (id: string) => void;
  /** Desktop-only: render as a thin collapsed strip. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
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

function parseSessionDate(value?: string): Date | null {
  if (!value) return null;
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatCreatedDate(value?: string): string {
  const date = parseSessionDate(value);
  if (!date) return "Creation date unavailable";
  return `Created ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)}`;
}

function formatFullDate(value?: string): string {
  const date = parseSessionDate(value);
  if (!date) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

function SessionItem({
  s,
  isActive,
  onSelect,
  onSaved,
  onDeleted,
  onRunStatusRead,
}: {
  s: SessionSummary;
  isActive: boolean;
  onSelect: () => void;
  onSaved: (nick: string) => void;
  onDeleted: () => void;
  onRunStatusRead: (runStatus: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoPosition, setInfoPosition] = useState({ top: 0, left: 0 });
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const nick = s.nickname || s.work_dir.split("/").pop() || s.session_id.slice(0, 8);
  const [draft, setDraft] = useState(nick);
  const inputRef = useRef<HTMLInputElement>(null);
  const infoButtonRef = useRef<HTMLButtonElement>(null);
  const infoPopupRef = useRef<HTMLDivElement>(null);
  const createdAt = s.created_at || s.updated_at;

  useEffect(() => {
    if (!infoOpen) return;
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (infoButtonRef.current?.contains(target) || infoPopupRef.current?.contains(target)) return;
      setInfoOpen(false);
    };
    const closeOnLayoutChange = () => setInfoOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInfoOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnLayoutChange);
    window.addEventListener("scroll", closeOnLayoutChange, true);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnLayoutChange);
      window.removeEventListener("scroll", closeOnLayoutChange, true);
    };
  }, [infoOpen]);

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

  const toggleInfo = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (infoOpen) {
      setInfoOpen(false);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const popupWidth = Math.min(384, window.innerWidth - 24);
    const popupHeight = 310;
    const rightSide = rect.right + 8;
    const left = rightSide + popupWidth <= window.innerWidth - 12
      ? rightSide
      : Math.max(12, rect.left - popupWidth - 8);
    const top = Math.max(12, Math.min(rect.top - 16, window.innerHeight - popupHeight - 12));
    setInfoPosition({ top, left });
    setInfoOpen(true);
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
    <div className="relative">
      {/* Delete confirmation modal */}
      <PopupPresence show={confirming}>
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={cancelConfirm}
        >
          <div
            data-popup-title="Delete simulation"
            className="amd-popup-enter bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl flex flex-col gap-4 p-6 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-red-100 dark:bg-red-900/40 text-red-500 dark:text-red-400 flex-shrink-0">
                <Trash2 size={16} />
              </div>
              <div>
                <p className="text-sm text-gray-500 mt-0.5">
                  <span className="text-gray-700 dark:text-gray-300 font-medium">{nick}</span>
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-600 mt-1">Output files on disk are kept.</p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium disabled:opacity-50 transition-colors"
              >
                <Check size={13} /> {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
            <PopupTailClose onClick={() => setConfirming(false)} label="Cancel simulation deletion" />
          </div>
        </div>
      </PopupPresence>

      <PopupPresence show={infoOpen} duration={400}>
        <div
          ref={infoPopupRef}
          role="dialog"
          aria-label={`${nick} simulation information`}
          data-popup-title="Simulation information"
          className="amd-popover-enter fixed z-[80] w-96 max-w-[calc(100vw-24px)] rounded-xl border border-cyan-200/70 bg-white/95 p-3.5 text-left shadow-2xl backdrop-blur-md dark:border-cyan-500/20 dark:bg-gray-900/95"
          style={{ top: infoPosition.top, left: infoPosition.left }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-3 flex items-start gap-2.5 border-b border-gray-100 pb-2.5 dark:border-gray-800">
            <div className="mt-0.5 rounded-lg bg-cyan-50 p-1.5 text-cyan-600 dark:bg-cyan-950/60 dark:text-cyan-300">
              <Info size={14} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{nick}</p>
              <div className="mt-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                <span className={statusDotClass(s.run_status)} />
                {s.run_status || "standby"}
              </div>
            </div>
          </div>

          <dl className="space-y-2.5 text-xs">
            <div className="grid grid-cols-[76px_1fr] gap-2">
              <dt className="text-gray-400 dark:text-gray-500">Created</dt>
              <dd className="text-gray-700 dark:text-gray-300">{formatFullDate(createdAt)}</dd>
            </div>
            <div className="grid grid-cols-[76px_1fr] gap-2">
              <dt className="text-gray-400 dark:text-gray-500">Updated</dt>
              <dd className="text-gray-700 dark:text-gray-300">{formatFullDate(s.updated_at)}</dd>
            </div>
            <div className="grid grid-cols-[76px_1fr] gap-2">
              <dt className="text-gray-400 dark:text-gray-500">Molecule</dt>
              <dd className="truncate text-gray-700 dark:text-gray-300" title={s.selected_molecule || undefined}>
                {s.selected_molecule || "Not selected"}
              </dd>
            </div>
            <div className="grid grid-cols-[76px_1fr] gap-2">
              <dt className="text-gray-400 dark:text-gray-500">Session ID</dt>
              <dd className="break-all font-mono text-[10px] text-gray-600 dark:text-gray-400">{s.session_id}</dd>
            </div>
            <div className="grid grid-cols-[76px_1fr] gap-2">
              <dt className="text-gray-400 dark:text-gray-500">Directory</dt>
              <dd className="break-all font-mono text-[10px] leading-relaxed text-gray-600 dark:text-gray-400">{s.work_dir}</dd>
            </div>
          </dl>
          <PopupTailClose onClick={() => setInfoOpen(false)} label="Close simulation information" />
        </div>
      </PopupPresence>

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
        onClick={async () => {
          if (editing || confirming) return;
          setRestoreError(null);
          try {
            await restoreSession(s.session_id, s.work_dir, s.nickname);
            onSelect();
            getSessionRunStatus(s.session_id)
              .then(({ run_status }) => onRunStatusRead(run_status))
              .catch(() => {});
          } catch {
            setRestoreError("Failed to load simulation — data may be missing or corrupted.");
          }
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
              <button onClick={save} className="amd-check-action flex-shrink-0">
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
          <div className="pl-3 text-[10px] text-gray-400 dark:text-gray-600 truncate">{formatCreatedDate(createdAt)}</div>
        )}
        {restoreError && (
          <p className="pl-3 mt-0.5 text-[10px] text-red-400 dark:text-red-500 leading-tight">{restoreError}</p>
        )}
      </div>

      {/* Full-height action buttons — visible on hover */}
      {!editing && (
        <div className={`${infoOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"} flex flex-shrink-0 transition-opacity border-l border-gray-200/60 dark:border-gray-700/40`}>
          <button
            onClick={startEdit}
            className="flex items-center justify-center w-7 text-gray-400 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/30 transition-colors"
            title="Rename"
          >
            <Pencil size={10} />
          </button>
          <button
            ref={infoButtonRef}
            onClick={toggleInfo}
            className={`flex items-center justify-center w-7 transition-colors border-l border-gray-200/60 dark:border-gray-700/40 ${
              infoOpen
                ? "bg-cyan-50 text-cyan-600 dark:bg-cyan-950/50 dark:text-cyan-300"
                : "text-gray-400 dark:text-gray-600 hover:text-cyan-600 dark:hover:text-cyan-300 hover:bg-cyan-50 dark:hover:bg-cyan-950/30"
            }`}
            title="Simulation information"
            aria-expanded={infoOpen}
          >
            <Info size={10} />
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
    </div>
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
  verifyError,
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
  verifyError: string | null;
  onVerify: () => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">
        <span className={`w-2 h-2 rounded-full ${color} inline-block flex-shrink-0`} />
        {label}
      </label>
      <div className="flex items-center gap-1.5">
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
          className="amd-primary-button px-2 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 flex-shrink-0"
        >
          {saved ? <Check size={12} className="amd-check-icon" /> : saving ? "…" : "Save"}
        </button>
        {verified !== null ? (
          <span className={`flex-shrink-0 ${verified ? "text-emerald-500" : "text-red-400"}`} title={verified ? "Verified" : verifyError || "Invalid"}>
            {verified ? <CircleCheck size={14} className="amd-check-icon" /> : <CircleX size={14} />}
          </span>
        ) : verifying ? (
          <Loader2 size={14} className="animate-spin text-gray-400 flex-shrink-0" />
        ) : (
          <span className="w-[14px] flex-shrink-0" />
        )}
      </div>
      {verified === false && verifyError && (
        <p className="mt-0.5 text-[10px] text-red-400 dark:text-red-500">{verifyError}</p>
      )}
    </div>
  );
}

const AGENT_BACKENDS = [
  { id: "claude_code", label: "Claude Code" },
  { id: "codex",       label: "Codex" },
  { id: "anthropic",   label: "Claude" },
  { id: "openai",      label: "ChatGPT" },
  { id: "deepseek",    label: "DeepSeek" },
] as const;

type AgentBackendId = typeof AGENT_BACKENDS[number]["id"];

export function SettingsModal({ username, onClose }: { username: string; onClose: () => void }) {
  const { theme, toggle } = useTheme();

  // API keys state
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [verified, setVerified] = useState<Record<string, boolean | null>>({});
  const [verifying, setVerifying] = useState<Record<string, boolean>>({});
  const [verifyErrors, setVerifyErrors] = useState<Record<string, string | null>>({});

  // Agent backbone
  const [agentBackend, setAgentBackend] = useState<AgentBackendId>("anthropic");

  useEffect(() => {
    getApiKeys(username).then(({ keys: k }) => {
      setKeys(k);
      // Auto-verify stored keys
      for (const svc of ["anthropic", "openai", "deepseek"]) {
        if (k[svc]) {
          setVerifying((v) => ({ ...v, [svc]: true }));
          verifyApiKey(username, svc)
            .then((res) => {
              setVerified((v) => ({ ...v, [svc]: res.valid }));
              setVerifyErrors((e) => ({ ...e, [svc]: res.error ?? null }));
            })
            .catch((err) => {
              setVerified((v) => ({ ...v, [svc]: false }));
              setVerifyErrors((e) => ({ ...e, [svc]: String(err) }));
            })
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
    setVerifyErrors((e) => ({ ...e, [service]: null }));
    try {
      const res = await verifyApiKey(username, service);
      setVerified((v) => ({ ...v, [service]: res.valid }));
      setVerifyErrors((e) => ({ ...e, [service]: res.error ?? null }));
    } catch (err) {
      setVerified((v) => ({ ...v, [service]: false }));
      setVerifyErrors((e) => ({ ...e, [service]: String(err) }));
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
    setVerifyErrors((e) => ({ ...e, [service]: null }));
  };

  const gmxImage = "gromacs-plumed:latest";
  const sysVersion = "0.1.0";

  const bumpAvatar = useSessionStore((s) => s.bumpAvatar);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const handleAvatarPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAvatarError(null);
    setAvatarBusy(true);
    try {
      await uploadAvatar(file);
      bumpAvatar();
    } catch (err) {
      setAvatarError((err as Error).message || "Upload failed");
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleAvatarRemove = async () => {
    setAvatarError(null);
    setAvatarBusy(true);
    try {
      await deleteAvatar();
      bumpAvatar();
    } catch {
      setAvatarError("Could not remove photo");
    } finally {
      setAvatarBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div data-popup-title="Settings" className="amd-popup-enter relative w-[520px] max-h-[90vh] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6" style={{ scrollbarWidth: "thin" }}>

          {/* ── Account ── */}
          <div className="space-y-3">
            <div className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700/50">
              <UserAvatar size={44} fallback="initial" className="amd-brand-mark rounded-full text-slate-900 text-base font-semibold shadow" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{username}</div>
                <div className="text-[10px] text-gray-400 dark:text-gray-500">Signed in</div>
              </div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={handleAvatarPick}
              />
              <button
                onClick={() => avatarInputRef.current?.click()}
                disabled={avatarBusy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
              >
                {avatarBusy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                Photo
              </button>
              <button
                onClick={handleAvatarRemove}
                disabled={avatarBusy}
                title="Remove photo"
                className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
              >
                <Trash2 size={14} />
              </button>
            </div>
            {avatarError && <p className="text-[11px] text-red-500 dark:text-red-400 px-1">{avatarError}</p>}
          </div>

          {/* ── Agent Backbone ── */}
          <div className="space-y-3">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              <Bot size={12} />
              Agent Backbone
            </h4>
            <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden h-[36px]">
              {AGENT_BACKENDS.map((b, i) => {
                const isActive = agentBackend === b.id;
                return (
                  <button
                    type="button"
                    key={b.id}
                    onClick={() => handleSetBackend(b.id)}
                    title={`Use ${b.label} as agent backbone`}
                    className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-medium transition-colors ${
                      isActive
                        ? "amd-selection-highlight"
                        : "bg-gray-50 dark:bg-gray-800/40 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                    } ${i < AGENT_BACKENDS.length - 1 ? "border-r border-gray-200 dark:border-gray-700" : ""}`}
                  >
                    {b.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-gray-400 dark:text-gray-600">
              Claude Code and Codex use their saved login. API backbones show their key below.
            </p>
            {agentBackend === "anthropic" && (
              <ApiKeyRow
                label="Claude API key"
                color="bg-orange-400"
                value={keys["anthropic"] ?? ""}
                onChange={(v) => setKeyValue("anthropic", v)}
                placeholder="sk-ant-..."
                onSave={() => handleSaveKey("anthropic")}
                saving={saving["anthropic"] ?? false}
                saved={saved["anthropic"] ?? false}
                verified={verified["anthropic"] ?? null}
                verifying={verifying["anthropic"] ?? false}
                verifyError={verifyErrors["anthropic"] ?? null}
                onVerify={() => handleVerify("anthropic")}
              />
            )}
            {agentBackend === "openai" && (
              <ApiKeyRow
                label="ChatGPT API key"
                color="bg-emerald-400"
                value={keys["openai"] ?? ""}
                onChange={(v) => setKeyValue("openai", v)}
                placeholder="sk-..."
                onSave={() => handleSaveKey("openai")}
                saving={saving["openai"] ?? false}
                saved={saved["openai"] ?? false}
                verified={verified["openai"] ?? null}
                verifying={verifying["openai"] ?? false}
                verifyError={verifyErrors["openai"] ?? null}
                onVerify={() => handleVerify("openai")}
              />
            )}
            {agentBackend === "deepseek" && (
              <ApiKeyRow
                label="DeepSeek API key"
                color="bg-blue-400"
                value={keys["deepseek"] ?? ""}
                onChange={(v) => setKeyValue("deepseek", v)}
                placeholder="sk-..."
                onSave={() => handleSaveKey("deepseek")}
                saving={saving["deepseek"] ?? false}
                saved={saved["deepseek"] ?? false}
                verified={verified["deepseek"] ?? null}
                verifying={verifying["deepseek"] ?? false}
                verifyError={verifyErrors["deepseek"] ?? null}
                onVerify={() => handleVerify("deepseek")}
              />
            )}
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
              <div className="flex items-center justify-between px-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  {theme === "dark" ? <Moon size={15} className="text-indigo-400" /> : <Sun size={15} className="text-amber-500" />}
                  <span className="text-xs text-gray-500 dark:text-gray-400">{theme === "dark" ? "Dark" : "Light"} mode</span>
                </div>
                <button
                  onClick={toggle}
                  aria-label="Toggle light and dark mode"
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
        <PopupTailClose onClick={onClose} label="Close settings" />
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

export function ServerStatusModal({ onClose }: { onClose: () => void }) {
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div data-popup-title="Server status" className="amd-popup-enter relative w-[520px] max-h-[85vh] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Monitor size={16} className="text-emerald-500" />
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Live resources</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => fetchStatus(true)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title="Refresh"
            >
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
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
        <PopupTailClose onClick={onClose} label="Close server status" />
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
        <div className="amd-brand-mark w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-slate-900 text-sm font-semibold shadow">
          {initial}
        </div>
        <span className="flex-1 text-left text-sm font-medium text-gray-700 dark:text-gray-300 truncate group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
          {username}
        </span>
        <Settings size={18} className="text-gray-400 dark:text-gray-600 group-hover:text-gray-600 dark:group-hover:text-gray-400 flex-shrink-0 transition-colors" />
      </button>

      {/* Popover menu */}
      <PopupPresence show={open} duration={400}>
        <div data-popup-title="Profile" className="amd-popover-enter absolute bottom-full left-3 right-3 mb-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl overflow-hidden z-50">
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
          <PopupTailClose onClick={() => setOpen(false)} label="Close profile menu" />
        </div>
      </PopupPresence>

      <PopupPresence show={settingsOpen}>
        <SettingsModal username={username} onClose={() => setSettingsOpen(false)} />
      </PopupPresence>
      <PopupPresence show={serverStatusOpen}>
        <ServerStatusModal onClose={() => setServerStatusOpen(false)} />
      </PopupPresence>
    </div>
  );
}

// ── Project list item ─────────────────────────────────────────────────

function ProjectItem({
  p,
  onOpen,
  onDeleted,
}: {
  p: { project_id: string; name: string; simulation_count?: number };
  onOpen: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <div className="relative">
      <PopupPresence show={confirming}>
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={(e) => { e.stopPropagation(); setConfirming(false); }}
        >
          <div
            data-popup-title="Delete project"
            className="amd-popup-enter bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl flex flex-col gap-4 p-6 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-red-100 dark:bg-red-900/40 text-red-500 dark:text-red-400 flex-shrink-0">
                <Trash2 size={16} />
              </div>
              <div>
                <p className="text-sm text-gray-500 mt-0.5">
                  <span className="text-gray-700 dark:text-gray-300 font-medium">{p.name}</span>
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-600 mt-1">Simulations are kept — only the grouping is removed.</p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={async (e) => { e.stopPropagation(); setDeleting(true); await onDeleted(); }}
                disabled={deleting}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium disabled:opacity-50 transition-colors"
              >
                <Check size={13} /> {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
            <PopupTailClose onClick={() => setConfirming(false)} label="Cancel project deletion" />
          </div>
        </div>
      </PopupPresence>

      <div className="group relative w-full rounded-lg transition-colors cursor-pointer flex overflow-hidden text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800/60 hover:text-gray-900 dark:hover:text-gray-200">
        <div className="flex-1 min-w-0 px-3 py-2.5" onClick={onOpen}>
          <div className="flex items-center gap-2">
            <FolderOpen size={13} className="flex-shrink-0 text-blue-500/70" />
            <span className="text-xs font-medium truncate flex-1">{p.name}</span>
            <span className="text-[10px] text-gray-400 dark:text-gray-600 flex-shrink-0 tabular-nums">{p.simulation_count ?? 0}</span>
          </div>
        </div>
        <div className="opacity-0 group-hover:opacity-100 flex flex-shrink-0 transition-opacity border-l border-gray-200/60 dark:border-gray-700/40">
          <button
            onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
            className="flex items-center justify-center w-7 text-gray-400 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            title="Delete project"
          >
            <Trash2 size={10} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main sidebar ───────────────────────────────────────────────────────

export default function SessionSidebar({ onNewSession, onSelectSession, onSessionDeleted, collapsed, onToggleCollapse }: Props) {
  const { sessions, sessionsLoading, sessionId, switchSession, clearSession, updateSessionNickname, removeSession, setSessionRunStatus } =
    useSessionStore();

  // Collapsed strip — a thin rail that expands the panel when clicked.
  if (collapsed) {
    return (
      <aside className="w-10 flex-shrink-0 overflow-hidden bg-white dark:bg-gray-950 border-r border-gray-200 dark:border-gray-800 flex flex-col h-full transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]">
        <button
          onClick={onToggleCollapse}
          title="Expand simulations panel"
          className="flex-1 flex flex-col items-center justify-start gap-3 pt-3 text-gray-400 dark:text-gray-600 hover:text-gray-900 dark:hover:text-gray-300 transition-colors"
        >
          <ChevronRight size={15} />
          <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ writingMode: "vertical-rl" }}>
            Simulations
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-64 flex-shrink-0 overflow-hidden bg-white dark:bg-gray-950 border-r border-gray-200 dark:border-gray-800 flex flex-col h-full transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]">
      {/* Header — "Simulations" label + collapse control, pinned to the top */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1.5 flex-shrink-0">
        <p className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-600">Simulations</p>
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            title="Collapse panel"
            className="hidden md:inline-flex p-0.5 rounded text-gray-400 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <ChevronLeft size={14} />
          </button>
        )}
      </div>

      {/* New Simulation */}
      <div className="px-3 pb-2.5 flex-shrink-0">
        <button
          onClick={onNewSession}
          className="amd-primary-button amd-new-simulation-button h-[46px] w-full flex items-center justify-center gap-2 px-3 rounded-lg text-xs font-medium"
        >
          <Plus size={12} />
          <span>New Simulation</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sessionsLoading && sessions.length === 0 ? (
          <div className="px-1 py-2">
            <div className="flex items-center gap-2 px-2 mb-3">
              <Loader2 size={11} className="animate-spin text-gray-400" />
              <span className="text-[11px] text-gray-400 dark:text-gray-600">Loading simulations…</span>
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
          <p className="text-[11px] text-gray-400 dark:text-gray-600 px-3 py-2">No simulations yet</p>
        ) : (
          <div className="space-y-0.5">
            {sessions.map((s) => (
              <SessionItem
                key={s.session_id}
                s={s}
                isActive={s.session_id === sessionId}
                onSelect={() => {
                  if (s.session_id === sessionId) {
                    clearSession();
                    onSelectSession?.(null);
                    return;
                  }
                  switchSession(s.session_id, s.work_dir);
                  onSelectSession?.(s.session_id);
                }}
                onSaved={(nick) => updateSessionNickname(s.session_id, nick)}
                onDeleted={() => { removeSession(s.session_id); onSessionDeleted?.(s.session_id); }}
                onRunStatusRead={(rs) => setSessionRunStatus(s.session_id, rs as "standby" | "running" | "finished" | "failed")}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
