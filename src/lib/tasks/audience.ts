/* ---------------------------------------------------------------------------
 * WHO GETS A TASK — PURE, client-safe, no I/O.
 *
 * A task (once, or a routine every day it runs) is given to an AUDIENCE: a
 * list of rules to include and a list to exclude. A rule names one person, a
 * team (everybody under a manager on the org chart), a designation or a
 * department from HRMS, a level in the task's app, an ERP designation, or
 * everybody who can see it.
 *
 * THE MOST SPECIFIC RULE WINS. A person named on their own beats any group:
 *   - a person EXCLUDED by name never gets it;
 *   - a person INCLUDED by name always gets it, even where their team or
 *     designation is excluded — "exclude Rahul's team, but include Priya";
 *   - everybody else gets it when a group includes them and no group
 *     excludes them — "include every Telecaller, except Rahul's team".
 *
 * The people a rule can reach are the CANDIDATES the server hands over: those
 * who hold the task's app (or Tasks, for a personal task) and are in the
 * giver's team. A rule never reaches past them, so a designation picked today
 * reaches only the giver's own people with the app — and, for a routine,
 * whoever matches on the day it runs.
 * ------------------------------------------------------------------------- */

import type { FieldProblem } from "./rules";

export const AUDIENCE_KINDS = ["everyone", "person", "team", "designation", "department", "level", "erpDesignation"] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

export const AUDIENCE_KIND_LABEL: Record<AudienceKind, string> = {
  everyone: "Everybody",
  person: "Person",
  team: "Team",
  designation: "Designation",
  department: "Department",
  level: "Level in the app",
  erpDesignation: "ERP designation",
};

export type AudienceRule = { kind: AudienceKind; value: string; label: string };
export type Audience = { include: AudienceRule[]; exclude: AudienceRule[] };

/** One person a rule could reach. */
export type AudiencePerson = {
  id: string;
  name: string;
  /** Their level in the task's app: associate, manager or admin. */
  level: string | null;
  designation: string | null;
  department: string | null;
  erpDesignation: string | null;
  /** Everybody above them on the org chart, nearest first. */
  managers: string[];
};

export const LEVEL_LABEL: Record<string, string> = { associate: "Associate", manager: "Manager", admin: "Admin" };

export const EMPTY_AUDIENCE: Audience = { include: [], exclude: [] };

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Does this rule reach this person? */
export function ruleMatches(rule: AudienceRule, p: AudiencePerson): boolean {
  switch (rule.kind) {
    case "everyone":
      return true;
    case "person":
      return p.id === rule.value;
    case "team":
      return p.managers.includes(rule.value);
    case "designation":
      return Boolean(p.designation) && norm(p.designation) === norm(rule.value);
    case "department":
      return Boolean(p.department) && norm(p.department) === norm(rule.value);
    case "level":
      return p.level === rule.value;
    case "erpDesignation":
      return Boolean(p.erpDesignation) && norm(p.erpDesignation) === norm(rule.value);
  }
}

export type Resolved = {
  /** Who gets it, by id, in name order. */
  ids: string[];
  /** Why each person got it or did not, for the preview. */
  why: Map<string, { in: boolean; because: string }>;
};

/** Who the audience reaches among the candidates. */
export function resolveAudience(a: Audience, people: AudiencePerson[]): Resolved {
  const why = new Map<string, { in: boolean; because: string }>();
  const ids: string[] = [];
  const sorted = [...people].sort((x, y) => x.name.localeCompare(y.name));
  for (const p of sorted) {
    const outByName = a.exclude.find((r) => r.kind === "person" && r.value === p.id);
    const inByName = a.include.find((r) => r.kind === "person" && r.value === p.id);
    let verdict: { in: boolean; because: string } | null = null;
    if (outByName) verdict = { in: false, because: "Excluded by name" };
    else if (inByName) verdict = { in: true, because: "Included by name" };
    else {
      const inBy = a.include.find((r) => r.kind !== "person" && ruleMatches(r, p));
      const outBy = a.exclude.find((r) => r.kind !== "person" && ruleMatches(r, p));
      if (inBy && outBy) verdict = { in: false, because: `Excluded: ${outBy.label}` };
      else if (inBy) verdict = { in: true, because: inBy.label };
    }
    if (verdict) why.set(p.id, verdict);
    if (verdict?.in) ids.push(p.id);
  }
  return { ids, why };
}

/** "Everybody in Sales Manager, except Rahul Mehta" — for a card or a list row. */
export function audienceWords(a: Audience): string {
  if (!a.include.length) return "Nobody yet";
  const inc = a.include.map((r) => r.label).join(", ");
  const exc = a.exclude.map((r) => r.label).join(", ");
  return exc ? `${inc} — except ${exc}` : inc;
}

export function ruleKey(r: Pick<AudienceRule, "kind" | "value">): string {
  return `${r.kind}:${r.value}`;
}

/** Everything wrong with an audience as typed. */
export function audienceProblems(a: Audience): FieldProblem[] {
  const out: FieldProblem[] = [];
  if (!a.include.length) out.push({ field: "audience", message: "Include at least one person or group." });
  const inc = new Set(a.include.map(ruleKey));
  const both = a.exclude.find((r) => inc.has(ruleKey(r)));
  if (both) out.push({ field: "audience", message: `${both.label} is both included and excluded — take it out of one list.` });
  for (const r of [...a.include, ...a.exclude]) {
    if (!(AUDIENCE_KINDS as readonly string[]).includes(r.kind) || (r.kind !== "everyone" && !r.value?.trim())) {
      out.push({ field: "audience", message: "One of the rules is incomplete." });
      break;
    }
  }
  return out;
}

/** What a stored audience reads as, from JSON that may be anything. */
export function readAudience(raw: unknown): Audience | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { include?: unknown; exclude?: unknown };
  const list = (v: unknown): AudienceRule[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is AudienceRule => Boolean(x) && typeof x === "object" && (AUDIENCE_KINDS as readonly string[]).includes((x as AudienceRule).kind))
          .map((x) => ({ kind: x.kind, value: String(x.value ?? ""), label: String(x.label ?? x.value ?? "") }))
      : [];
  return { include: list(r.include), exclude: list(r.exclude) };
}

/* -------------------------------------------------- the choices to offer */

export type AudienceChoices = Record<Exclude<AudienceKind, "everyone">, { value: string; label: string; count: number }[]>;

/**
 * What the builder can offer, read off the candidates themselves, so only a
 * designation somebody with the app holds is offered, with how many hold it.
 */
export function audienceChoices(people: AudiencePerson[], names: Map<string, string>): AudienceChoices {
  const tally = (pick: (p: AudiencePerson) => string | null) => {
    const m = new Map<string, { label: string; count: number }>();
    for (const p of people) {
      const v = pick(p)?.trim();
      if (!v) continue;
      const k = norm(v);
      const e = m.get(k);
      if (e) e.count++;
      else m.set(k, { label: v, count: 1 });
    }
    return [...m.values()].map((e) => ({ value: e.label, label: e.label, count: e.count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  const teams = new Map<string, number>();
  for (const p of people) for (const m of p.managers) teams.set(m, (teams.get(m) ?? 0) + 1);
  return {
    person: [...people].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name, count: 1 })),
    team: [...teams.entries()]
      .filter(([id]) => names.has(id))
      .map(([id, count]) => ({ value: id, label: `Everyone under ${names.get(id)}`, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    designation: tally((p) => p.designation),
    department: tally((p) => p.department),
    level: tally((p) => (p.level ? (LEVEL_LABEL[p.level] ?? p.level) : null)).map((c) => ({
      ...c,
      value: Object.entries(LEVEL_LABEL).find(([, l]) => l === c.label)?.[0] ?? c.value,
    })),
    erpDesignation: tally((p) => p.erpDesignation),
  };
}
