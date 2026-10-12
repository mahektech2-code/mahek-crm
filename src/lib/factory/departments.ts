/* ---------------------------------------------------------------------------
 * WHERE A PERSON WORKS ON THE FLOOR, and what that lets them do. PURE and
 * client-safe: the Access dialog in the Admin Console draws it, and the
 * factory server enforces it, from this one copy.
 *
 * A person's Factory standing is two answers given together:
 *   - the DEPARTMENTS — any of mixing, filling, packing, dispatch and
 *     quality, or the whole floor — and their place in each one's crew;
 *   - the LEVEL on the Factory grant.
 * Together they are the department-level permission:
 *
 *   associate in departments   → works those departments' jobs, nobody else's
 *   manager of departments     → supervises THOSE departments: gives their work,
 *                                changes their teams, decides their review items
 *   manager of the whole floor → the Production Head: every department
 *
 * A Production Head is a manager by definition, so picking "whole floor"
 * raises the level with it — the way an ERP designation sets the ERP's.
 * ------------------------------------------------------------------------- */
import type { Proc } from "./types";

export const FACTORY_DEPTS = ["head", "mixing", "filling", "packing", "dispatch", "qc"] as const;
export type FactoryDept = (typeof FACTORY_DEPTS)[number];

export const DEPT_LABEL: Record<FactoryDept, string> = {
  head: "Whole floor (Production Head)",
  mixing: "Mixing & blending",
  filling: "Refilling / filling",
  packing: "Packing",
  dispatch: "Dispatch",
  qc: "Quality",
};

export const CREW_ROLES = ["owner", "operator", "helper", "verifier"] as const;
export type CrewRole = (typeof CREW_ROLES)[number];

export const CREW_LABEL: Record<CrewRole, string> = {
  owner: "In charge",
  operator: "Machine operator",
  helper: "Helper",
  verifier: "Checks the work",
};

/** Dispatch calls its operator the lead loader. */
export const crewLabel = (dept: FactoryDept, crew: CrewRole) => (dept === "dispatch" && crew === "operator" ? "Lead loader" : CREW_LABEL[crew]);

/**
 * A person's place on the floor, as the Access dialog sets it. A person may
 * work in SEVERAL departments — a loader who helps on the packing line, an
 * operator who mixes in the morning and fills in the afternoon — so the
 * departments are a list, and their seat in each one's standing crew is
 * answered per department. The whole floor is a list of one: it already
 * covers every department.
 */
export type FactoryPlace = {
  /** Every department they work in, in `FACTORY_DEPTS` order. Never empty. */
  depts: FactoryDept[];
  /** Their seat in each department's standing crew — what a new job starts with. A department missing here: on it, in no standing seat. */
  crews: Partial<Record<Proc, CrewRole>>;
  /** The badge QR; empty uses their HRMS employee code. */
  badge: string | null;
  /** False while HR has still to confirm the name or the role (PRD §5.1). */
  hrConfirmed: boolean;
};

export const isProc = (d: string): d is Proc => d === "mixing" || d === "filling" || d === "packing" || d === "dispatch";

/**
 * The list as it is stored: known departments only, each once, in
 * `FACTORY_DEPTS` order — and the whole floor alone, because picking it as
 * well as a department would say the same thing twice.
 */
export function cleanDepts(depts: readonly string[]): FactoryDept[] {
  const set = new Set(depts.filter((d): d is FactoryDept => (FACTORY_DEPTS as readonly string[]).includes(d)));
  if (set.has("head")) return ["head"];
  return FACTORY_DEPTS.filter((d) => set.has(d));
}

/** The production departments among them — the ones that have jobs. */
export const procsOf = (depts: readonly string[]): Proc[] => cleanDepts(depts).filter(isProc);

/**
 * The departments somebody may SUPERVISE: none for a worker, their own for a
 * department manager, all four for the Production Head or a quality manager.
 * Null means every one.
 */
export function supervises(depts: readonly string[] | null | undefined, level: string): Proc[] | null {
  if (level !== "manager" && level !== "admin") return [];
  const d = cleanDepts(depts ?? []);
  if (!d.length || d.includes("head") || d.includes("qc")) return null;
  return d.filter(isProc);
}

const list = (words: string[]) => (words.length <= 1 ? words.join("") : words.slice(0, -1).join(", ") + " and " + words[words.length - 1]);

/** What the place lets them do, in the dialog's own words. */
export function placeSentence(p: FactoryPlace | null, level: string): string {
  if (!p || !p.depts.length) return "Tick at least one department. Without one they open the app and have no work in it.";
  const manager = level === "manager" || level === "admin";
  const d = cleanDepts(p.depts);
  if (d.includes("head")) return manager ? "Production Head: sees the whole floor, gives work to every department and decides every review item." : "The whole floor needs the manager level.";
  const procs = d.filter(isProc);
  const names = list(procs.map((x) => DEPT_LABEL[x]));
  const switcher = procs.length > 1 ? " On the phone they switch between them at the top of the screen." : "";
  if (d.includes("qc")) {
    if (manager) return "Quality manager: sees the whole floor and decides review items." + (procs.length ? ` Also does ${names} jobs.` : "");
    return (procs.length ? `Works ${names} jobs, and is` : "Quality:") + " chosen as the person who checked a job." + (procs.length ? switcher : " Has no jobs of their own.");
  }
  if (manager) return `Supervises ${names} only: gives their work, changes their teams and decides their review items. Does their jobs too.` + switcher;
  const seats = procs.filter((x) => p.crews[x]).map((x) => crewLabel(x, p.crews[x]!).toLowerCase() + " in " + DEPT_LABEL[x].toLowerCase());
  return `Works ${names} jobs only${seats.length ? ", as " + list(seats) + " on new jobs" : ""}.` + switcher;
}

/** Problems with a place, or "" — the action refuses on these; the dialog shows them. */
export function placeProblem(p: FactoryPlace | null | undefined, level: string): string {
  if (!p) return "";
  if (!p.depts.length) return "Tick at least one department.";
  if (p.depts.some((d) => !(FACTORY_DEPTS as readonly string[]).includes(d))) return "That is not a factory department.";
  if (p.depts.includes("head") && level !== "manager" && level !== "admin") return "The whole floor is the Production Head, which is the manager level.";
  for (const [d, c] of Object.entries(p.crews)) {
    if (!c) continue;
    if (!(CREW_ROLES as readonly string[]).includes(c)) return "That is not a crew role.";
    if (!isProc(d)) return "Only mixing, filling, packing and dispatch have a standing crew.";
    if (!p.depts.includes(d)) return `A crew seat in ${DEPT_LABEL[d]} needs that department ticked.`;
  }
  if (p.badge && !/^[A-Za-z0-9._-]{2,40}$/.test(p.badge)) return "A badge code is letters, numbers, dots or dashes.";
  return "";
}

/** The place in a few words, for the review page and the audit line. */
export function placeWords(p: FactoryPlace | null): string {
  if (!p || !p.depts.length) return "no department";
  return (
    cleanDepts(p.depts)
      .map((d) => DEPT_LABEL[d] + (isProc(d) && p.crews[d] ? " · " + crewLabel(d, p.crews[d]!) : ""))
      .join("; ") + (p.hrConfirmed ? "" : " · still to confirm with HR")
  );
}

/** A stored staff row as a place: `areas` where it is filled, else the one `area` it was written with. */
export function placeFromRow(r: { area: string; areas?: readonly string[] | null; badge: string | null; hrConfirmed: boolean; crews?: Partial<Record<string, string | null>> | null }): FactoryPlace {
  const depts = cleanDepts(r.areas?.length ? r.areas : [r.area]);
  const crews: Partial<Record<Proc, CrewRole>> = {};
  for (const d of depts.filter(isProc)) {
    const c = r.crews?.[d];
    if (c && (CREW_ROLES as readonly string[]).includes(c)) crews[d] = c as CrewRole;
  }
  return { depts, crews, badge: r.badge, hrConfirmed: r.hrConfirmed };
}
