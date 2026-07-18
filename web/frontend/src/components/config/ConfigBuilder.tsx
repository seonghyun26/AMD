"use client";

import { useEffect, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { getSessionConfig, updateSessionConfig } from "@/lib/api";
import { CheckCircle2 } from "lucide-react";

interface Props {
  sessionId: string;
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-0.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
      />
    </div>
  );
}

export default function ConfigBuilder({ sessionId }: Props) {
  const [cfg, setCfg] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSessionConfig(sessionId).then((r) => setCfg(r.config)).catch(() => {});
  }, [sessionId]);

  const gromacs = (cfg.gromacs ?? {}) as Record<string, unknown>;
  const method = (cfg.method ?? {}) as Record<string, unknown>;

  const handleSave = async () => {
    await updateSessionConfig(sessionId, cfg).catch(() => {});
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const setGromacs = (k: string, v: unknown) =>
    setCfg((c) => ({ ...c, gromacs: { ...(c.gromacs as object), [k]: v } }));
  const setMethod = (k: string, v: unknown) =>
    setCfg((c) => ({ ...c, method: { ...(c.method as object), [k]: v } }));

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Configuration</h3>
        <button
          onClick={handleSave}
          className="amd-primary-button flex items-center gap-1 text-xs px-2 py-1 rounded"
        >
          {saved ? <CheckCircle2 size={12} className="amd-check-icon" /> : null}
          {saved ? "Saved" : "Save"}
        </button>
      </div>

      <Tabs.Root defaultValue="method">
        <Tabs.List className="flex gap-1 mb-3 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
          {["method", "gromacs", "plumed"].map((tab) => (
            <Tabs.Trigger
              key={tab}
              value={tab}
              className="flex-1 text-xs py-1 rounded-md capitalize text-gray-500 dark:text-gray-400 data-[state=active]:bg-white dark:data-[state=active]:bg-gray-700 data-[state=active]:text-gray-900 dark:data-[state=active]:text-white data-[state=active]:shadow-sm transition-all"
            >
              {tab}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="method" className="space-y-2">
          <Field
            label="Steps"
            type="number"
            value={String(method.nsteps ?? "")}
            onChange={(v) => setMethod("nsteps", Number(v))}
          />
          <Field
            label="Temperature (K)"
            type="number"
            value={String((method as Record<string, unknown>).temperature ?? gromacs.ref_t ?? "300")}
            onChange={(v) => setMethod("temperature", Number(v))}
          />
          <Field
            label="Hills Height (kJ/mol)"
            type="number"
            value={String((method as Record<string, unknown>).hills_height ?? "")}
            onChange={(v) => setMethod("hills_height", Number(v))}
          />
          <Field
            label="Hills Pace"
            type="number"
            value={String((method as Record<string, unknown>).hills_pace ?? "")}
            onChange={(v) => setMethod("hills_pace", Number(v))}
          />
        </Tabs.Content>

        <Tabs.Content value="gromacs" className="space-y-2">
          <Field
            label="Timestep dt (ps)"
            type="number"
            value={String(gromacs.dt ?? "0.002")}
            onChange={(v) => setGromacs("dt", Number(v))}
          />
          <Field
            label="Reference Temperature (K)"
            type="number"
            value={String(gromacs.ref_t ?? "300")}
            onChange={(v) => setGromacs("ref_t", Number(v))}
          />
          <Field
            label="Coulomb Cutoff (nm)"
            type="number"
            value={String(gromacs.rcoulomb ?? "1.0")}
            onChange={(v) => setGromacs("rcoulomb", Number(v))}
          />
          <Field
            label="VdW Cutoff (nm)"
            type="number"
            value={String(gromacs.rvdw ?? "1.0")}
            onChange={(v) => setGromacs("rvdw", Number(v))}
          />
          <Field
            label="Random Seed"
            type="number"
            value={String(gromacs.gen_seed ?? "-1")}
            onChange={(v) => setGromacs("gen_seed", Number(v))}
            placeholder="-1 for random"
          />
        </Tabs.Content>

        <Tabs.Content value="plumed" className="space-y-2">
          <div className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 rounded p-2">
            PLUMED parameters are set by the agent dynamically based on your simulation description.
            You can instruct the agent via chat to modify specific CV or bias parameters.
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
