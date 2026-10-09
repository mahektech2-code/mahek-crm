/* ---------------------------------------------------------------------------
 * WHERE A PERSON WORKS ON THE FLOOR, and what that lets them do. PURE and
 * client-safe: the Access dialog in the Admin Console draws it, and the
 * factory server enforces it, from this one copy.
 *
 * A person's Factory standing is two answers given together:
 *   - the DEPARTMENT — mixing, filling, packing, dispatch, quality, or the
 *     whole floor — and their place in its crew;
 *   - the LEVEL on the Factory grant.
 * Together they are the department-level permission:
 *
 *   associate in a department  → works that department's jobs, nobody else's
 *   manager of a department    → supervises THAT department: gives its work,
 *                                changes its teams, decides its review items
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

/** A person's place on the floor, as the Access dialog sets it. */
export type FactoryPlace = {
  dept: FactoryDept;
  /** Their seat in the department's standing crew — what a new job starts with. Null: on the department, in no standing seat. */
  crew: CrewRole | null;
  /** The badge QR; empty uses their HRMS employee code. */
  badge: string | null;
  /** False while HR has still to confirm the name or the role (PRD §5.1). */
  hrConfirmed: boolean;
};

export const isProc = (d: string): d is Proc => d === "mixing" || d === "filling" || d === "packing" || d === "dispatch";

/**
 * The departments somebody may SUPERVISE: none for a worker, their own for a
 * department manager, all four for the Production Head. Null means every one.
 */
export function supervises(dept: FactoryDept | null | undefined, level: string): Proc[] | null | [] {
  if (level !== "manager" && level !== "admin") return [];
  if (!dept || dept === "head" || dept === "qc") return null;
  return [dept];
}

/** What the place lets them do, in the dialog's own words. */
export function placeSentence(p: FactoryPlace | null, level: string): string {
  if (!p) return "Pick a department. Without one they open the app and have no work in it.";
  const manager = level === "manager" || level === "admin";
  if (p.dept === "head") return manager ? "Production Head: sees the whole floor, gives work to every department and decides every review item." : "The whole floor needs the manager level.";
  if (p.dept === "qc") return manager ? "Quality manager: sees the whole floor and decides review items." : "Quality: chosen as the person who checked a job. Has no jobs of their own.";
  const name = DEPT_LABEL[p.dept];
  return manager
    ? `Supervises ${name} only: gives its work, changes its teams and decides its review items. Does its jobs too.`
    : `Works ${name} jobs only${p.crew ? ", as " + crewLabel(p.dept, p.crew).toLowerCase() + " on new jobs" : ""}.`;
}

/** Problems with a place, or "" — the action refuses on these; the dialog shows them. */
export function placeProblem(p: FactoryPlace | null | undefined, level: string): string {
  if (!p) return "";
  if (!(FACTORY_DEPTS as readonly string[]).includes(p.dept)) return "That is not a factory department.";
  if (p.dept === "head" && level !== "manager" && level !== "admin") return "The whole floor is the Production Head, which is the manager level.";
  if (p.crew && !(CREW_ROLES as readonly string[]).includes(p.crew)) return "That is not a crew role.";
  if (p.crew && !isProc(p.dept)) return "Only mixing, filling, packing and dispatch have a standing crew.";
  if (p.badge && !/^[A-Za-z0-9._-]{2,40}$/.test(p.badge)) return "A badge code is letters, numbers, dots or dashes.";
  return "";
}
