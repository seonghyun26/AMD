/** Shared helpers and constants for the MD Workspace. */

// ── Helpers ───────────────────────────────────────────────────────────

export function briefError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let msg = raw.split("\n")[0].trim();
  msg = msg.replace(/(?:\/[\w.\-/]+\/)([\w.\-]+)/g, "$1");
  if (msg.length > 120) msg = msg.slice(0, 117) + "\u2026";
  return msg || "Unknown error";
}

export function defaultNickname(): string {
  const now = new Date();
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const DD = String(now.getDate()).padStart(2, "0");
  const HH = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const SS = String(now.getSeconds()).padStart(2, "0");
  return `${MM}${DD}-${HH}${mm}${SS}`;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ── Presets ───────────────────────────────────────────────────────────

export interface Preset { id: string; label: string; description: string; tag: string }

export const PRESETS: Preset[] = [
  { id: "md",       label: "Molecular Dynamics", description: "Unbiased MD \u2014 no enhanced sampling",             tag: "MD"      },
  { id: "metad",    label: "Metadynamics",        description: "Well-tempered metadynamics with PLUMED",        tag: "MetaD"   },
  { id: "opes",     label: "OPES Metadynamics",   description: "On-the-fly probability enhanced sampling",      tag: "OPES"    },
  { id: "umbrella", label: "Umbrella Sampling",   description: "Umbrella sampling along a reaction coordinate", tag: "US"      },
  { id: "steered",  label: "Steered MD",           description: "Steered MD with moving restraint",              tag: "SMD"     },
];

// ── System options ─────────────────────────────────────────────────────

export interface SystemOption { id: string; label: string; description: string }

export const SYSTEMS: SystemOption[] = [
  { id: "ala_dipeptide", label: "Alanine Dipeptide",  description: "Blocked alanine dipeptide \u00b7 Ace-Ala-Nme" },
  { id: "chignolin",     label: "Chignolin (CLN025)", description: "10-residue \u03b2-hairpin mini-protein"        },
  { id: "trp_cage",      label: "Trp-cage (2JOF)",    description: "20-residue \u03b1-helical mini-protein"        },
  { id: "bba",           label: "BBA (1FME)",         description: "28-residue \u03b2\u03b2\u03b1 zinc-finger mini-protein"  },
  { id: "villin",        label: "Villin (2F4K)",      description: "35-residue villin headpiece subdomain"     },
  { id: "blank",         label: "Blank",              description: "No system \u2014 configure manually"           },
];

export const SYSTEM_LABELS: Record<string, string> = {
  ala_dipeptide: "Alanine Dipeptide",
  protein:       "Protein",
  membrane:      "Membrane",
  chignolin:     "Chignolin",
  trp_cage:      "Trp-cage",
  bba:           "BBA",
  villin:        "Villin",
};

// ── GROMACS templates ──────────────────────────────────────────────────

export interface GmxTemplate { id: string; label: string; description: string }

export const GMX_TEMPLATES: GmxTemplate[] = [
  { id: "vacuum", label: "Vacuum", description: "Dodecahedron vacuum box \u00b7 no solvent \u00b7 fast" },
  { id: "auto",   label: "Auto",   description: "Maximally compatible defaults \u00b7 PME \u00b7 solvated" },
  { id: "tip3p",  label: "TIP3P",  description: "Explicit TIP3P water \u00b7 PME \u00b7 NPT ensemble" },
];

// ── Mol file helpers ──────────────────────────────────────────────────

const MOL_EXTS = new Set(["pdb", "gro", "mol2", "xyz", "sdf"]);
export function isMolFile(path: string) {
  return MOL_EXTS.has(path.split(".").pop()?.toLowerCase() ?? "");
}

const STATIC_DERIVED_MOL_NAMES = new Set(["system.gro", "box.gro", "solvated.gro", "ionized.gro"]);

export function fileBaseName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function rootStem(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

export function expectedDerivedNames(rootName: string): string[] {
  const stem = rootStem(rootName);
  return [
    `${stem}_system.gro`,
    `${stem}_box.gro`,
    `${stem}_solvated.gro`,
    `${stem}_ionized.gro`,
  ];
}

export function isDerivedMolName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    STATIC_DERIVED_MOL_NAMES.has(n)
    || n.endsWith("_system.gro")
    || n.endsWith("_box.gro")
    || n.endsWith("_solvated.gro")
    || n.endsWith("_ionized.gro")
  );
}

export type MolTreeNode = {
  path: string;
  name: string;
  isDerived: boolean;
};

export type MolTreeGroup = {
  root: MolTreeNode;
  children: MolTreeNode[];
};

export function buildMolTreeGroups(molFiles: string[], originHint: string): MolTreeGroup[] {
  const byName = new Map<string, string>();
  for (const p of molFiles) byName.set(fileBaseName(p), p);

  const roots = molFiles
    .filter((p) => !isDerivedMolName(fileBaseName(p)))
    .sort((a, b) => fileBaseName(a).localeCompare(fileBaseName(b)));

  const hintName = fileBaseName(originHint || "");
  const activeRoot = roots.find((r) => fileBaseName(r) === hintName) ?? roots[0] ?? "";

  const groups: MolTreeGroup[] = [];
  for (const rootPath of roots) {
    const rootName = fileBaseName(rootPath);
    const children: MolTreeNode[] = [];

    const derivedNames = expectedDerivedNames(rootName);
    for (let i = 0; i < derivedNames.length; i++) {
      const dn = derivedNames[i];
      const dp = byName.get(dn);
      if (dp) children.push({ path: dp, name: dn, isDerived: true });
    }
    groups.push({ root: { path: rootPath, name: rootName, isDerived: false }, children });
  }

  if (groups.length === 0) {
    const preferred = [hintName, "system.gro", "box.gro", "solvated.gro", "ionized.gro"];
    const present = preferred
      .concat(Array.from(byName.keys()).sort())
      .filter((n, idx, arr) => byName.has(n) && arr.indexOf(n) === idx);
    if (present.length > 0) {
      const rootName = present[0];
      groups.push({
        root: { path: byName.get(rootName)!, name: rootName, isDerived: false },
        children: present.slice(1).map((n) => ({ path: byName.get(n)!, name: n, isDerived: true })),
      });
    }
  }

  if (activeRoot) {
    const activeRootName = fileBaseName(activeRoot);
    const ordered: MolTreeGroup[] = [];
    const rest: MolTreeGroup[] = [];
    for (const g of groups) {
      (g.root.name === activeRootName ? ordered : rest).push(g);
    }
    return [...ordered, ...rest];
  }

  return groups;
}

// ── File preview helpers ────────────────────────────────────────────────

const _BINARY_EXTS = new Set([".xtc", ".trr", ".edr", ".tpr", ".cpt", ".xdr", ".dms", ".gsd"]);

export function canPreview(name: string): "text" | "binary" {
  const ext = "." + (name.split(".").pop() ?? "").toLowerCase();
  if (_BINARY_EXTS.has(ext)) return "binary";
  return "text";
}
