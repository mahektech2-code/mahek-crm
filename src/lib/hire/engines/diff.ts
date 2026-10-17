import type { BlueprintDefinition, CalcRule, Question, Stage } from "../blueprint-types";
import { validateBlueprint, type Issue } from "./validator";

/* ---------------------------------------------------------------------------
 * WHAT CHANGED BETWEEN TWO BLUEPRINT VERSIONS (design §7.7). Pure.
 *
 * Structural, not textual: stages and questions are matched by their KEY, so
 * a reworded question reads as one row that changed rather than one removed
 * and one added — which is the difference between "we fixed the wording" and
 * "we dropped a question", and a reviewer needs to tell those apart.
 * ------------------------------------------------------------------------- */

export type DiffKind = "added" | "removed" | "changed";
export type DiffRow = { where: string; kind: DiffKind; a: string; b: string; note?: string };

const pts = (n: number | null | undefined) => (n == null ? "no score" : String(n));

function calcLine(c: CalcRule | undefined): string {
  if (!c) return "—";
  if (c.kind === "formula") return `${c.expression}${c.cap != null ? `, capped at ${c.cap}` : ", uncapped"}`;
  return c.bands.map((b) => `${b.min ?? "<"}–${b.max ?? ">"}: ${b.points}${b.to != null ? `→${b.to}` : ""}`).join(" · ") + (c.uncovered != null ? ` · else ${c.uncovered}` : "");
}

function optionsLine(q: Question): string {
  if (!q.options?.length) return "—";
  return q.options.map((o) => `${o.label} ${pts(o.points)}`).join(" · ") + (q.cumulative ? ` (cumulative${q.cap != null ? `, cap ${q.cap}` : ""})` : "");
}

function stageLine(s: Stage): string {
  return [s.type.replace(/_/g, " "), s.maxPoints ? `max ${s.maxPoints}` : null, s.questions.length ? `pass ${s.passThreshold}` : null].filter(Boolean).join(" · ");
}

export function diffBlueprints(a: BlueprintDefinition, b: BlueprintDefinition): DiffRow[] {
  const rows: DiffRow[] = [];
  const push = (where: string, kind: DiffKind, av: string, bv: string, note?: string) => rows.push({ where, kind, a: av, b: bv, note });

  /* Competencies */
  const ac = new Map(a.competencies.map((c) => [c.key, c]));
  const bc = new Map(b.competencies.map((c) => [c.key, c]));
  for (const [k, c] of bc) {
    const o = ac.get(k);
    if (!o) push(`Competency · ${c.name}`, "added", "—", `${c.name} · ${Math.round(c.weight * 100)}%`);
    else if (o.name !== c.name || Math.abs(o.weight - c.weight) > 1e-9) push(`Competency · ${c.name}`, "changed", `${o.name} · ${Math.round(o.weight * 100)}%`, `${c.name} · ${Math.round(c.weight * 100)}%`);
  }
  for (const [k, c] of ac) if (!bc.has(k)) push(`Competency · ${c.name}`, "removed", `${c.name} · ${Math.round(c.weight * 100)}%`, "—");

  /* Stages, their thresholds and their questions */
  const as = new Map(a.stages.map((s) => [s.key, s]));
  const bs = new Map(b.stages.map((s) => [s.key, s]));
  const order = [...b.stages.map((s) => s.key), ...a.stages.filter((s) => !bs.has(s.key)).map((s) => s.key)];
  for (const key of order) {
    const o = as.get(key);
    const n = bs.get(key);
    if (!o && n) {
      push(`Stage · ${n.name}`, "added", "—", stageLine(n), n.rationale);
      continue;
    }
    if (o && !n) {
      push(`Stage · ${o.name}`, "removed", stageLine(o), "—");
      continue;
    }
    if (!o || !n) continue;
    const where = `Stage · ${n.name}`;
    if (o.name !== n.name || o.type !== n.type) push(where, "changed", `${o.name} (${o.type})`, `${n.name} (${n.type})`);
    if (o.passThreshold !== n.passThreshold && (o.questions.length || n.questions.length)) push(`${where} · pass mark`, "changed", String(o.passThreshold), String(n.passThreshold));
    if (o.autoRejectFloor !== n.autoRejectFloor) push(`${where} · auto-reject floor`, "changed", pts(o.autoRejectFloor), pts(n.autoRejectFloor));
    if (o.graceRange !== n.graceRange) push(`${where} · grace`, "changed", `±${o.graceRange}`, `±${n.graceRange}`);
    if (o.slaHours !== n.slaHours) push(`${where} · SLA`, "changed", `${o.slaHours}h`, `${n.slaHours}h`);

    const aq = new Map(o.questions.map((q) => [q.key, q]));
    const bq = new Map(n.questions.map((q) => [q.key, q]));
    for (const [qk, q] of bq) {
      const p = aq.get(qk);
      const qw = `${n.name} · ${qk.toUpperCase()}`;
      if (!p) {
        push(qw, "added", "—", q.text, q.note);
        continue;
      }
      if (p.text !== q.text) push(qw, "changed", p.text, q.text);
      if (p.mode !== q.mode) push(`${qw} · scoring`, "changed", p.mode.replace("_", " "), q.mode.replace("_", " "), q.note);
      if (p.maxPoints !== q.maxPoints) push(`${qw} · max`, "changed", String(p.maxPoints), String(q.maxPoints));
      if (optionsLine(p) !== optionsLine(q)) push(`${qw} · options`, "changed", optionsLine(p), optionsLine(q), q.note);
      if (calcLine(p.calc) !== calcLine(q.calc)) push(`${qw} · rule`, "changed", calcLine(p.calc), calcLine(q.calc), q.note);
    }
    for (const [qk, q] of aq) if (!bq.has(qk)) push(`${o.name} · ${qk.toUpperCase()}`, "removed", q.text, "—");

    const ap = new Map((o.briefing ?? []).map((p) => [p.key, p]));
    for (const p of n.briefing ?? []) {
      const q = ap.get(p.key);
      if (!q) push(`${n.name} · ${p.title}`, "added", "—", `${p.body}${p.blocking ? " · blocking" : ""}`);
      else {
        if (q.blocking !== p.blocking) push(`${n.name} · ${p.title}`, "changed", q.blocking ? "Blocking" : "Does not block", p.blocking ? "Blocking" : "Does not block", p.blocking ? "A disagreement here now halts progression." : undefined);
        if (q.body !== p.body) push(`${n.name} · ${p.title} · wording`, "changed", q.body, p.body);
      }
    }
    for (const p of o.briefing ?? []) if (!(n.briefing ?? []).some((x) => x.key === p.key)) push(`${o.name} · ${p.title}`, "removed", p.body, "—");
  }

  /* Documents */
  const ad = new Set(a.documents.map((d) => d.key));
  const bd = new Set(b.documents.map((d) => d.key));
  for (const d of b.documents) if (!ad.has(d.key)) push(`Document · ${d.label}`, "added", "—", `${d.mandatory ? "Mandatory" : "Optional"} · ${d.pii}`);
  for (const d of a.documents) if (!bd.has(d.key)) push(`Document · ${d.label}`, "removed", `${d.mandatory ? "Mandatory" : "Optional"}`, "—");

  /* Offer: grades and the growth ladder */
  const grade = (g: BlueprintDefinition["offer"]["grades"][number]) => `₹${Math.round(g.basicMinPaise / 100).toLocaleString("en-IN")}–₹${Math.round(g.basicMaxPaise / 100).toLocaleString("en-IN")}`;
  const ag = new Map(a.offer.grades.map((g) => [g.key, g]));
  for (const g of b.offer.grades) {
    const o = ag.get(g.key);
    if (!o) push(`Grade · ${g.label}`, "added", "—", grade(g));
    else if (grade(o) !== grade(g)) push(`Grade · ${g.label}`, "changed", grade(o), grade(g));
  }
  const step = (s: BlueprintDefinition["offer"]["growth"][number]) => `${s.fromGrade}→${s.toGrade}: ${s.incrementType === "percentage" ? `${s.value}%` : `₹${Math.round(s.value / 100).toLocaleString("en-IN")}`}`;
  const ga = a.offer.growth.map(step).join(" · ") || "—";
  const gb = b.offer.growth.map(step).join(" · ") || "—";
  if (ga !== gb) push("Growth path", "changed", ga, gb, "One definition, read by the briefing and the offer letter alike.");

  /* Provisioning */
  const pa = [...a.provisioning.apps].sort().join(", ");
  const pb = [...b.provisioning.apps].sort().join(", ");
  if (pa !== pb || a.provisioning.roleLabel !== b.provisioning.roleLabel) push("Provisioning", "changed", `${pa} · ${a.provisioning.roleLabel}`, `${pb} · ${b.provisioning.roleLabel}`);

  return rows;
}

/* ---------------------------------------------------------------------------
 * STUDIO RULES — pure, so the editor validates live in the browser with the
 * same functions the publish action runs on the server.
 * ------------------------------------------------------------------------- */

/** The definition as stored, with the one approval the shared type does not carry. */
export type StudioDefinition = BlueprintDefinition & { competenciesApproved?: boolean };

/** Every element a person must approve, and how many have been. */
export function approvalCount(def: StudioDefinition): { approved: number; total: number; pending: string[] } {
  const items: [string, boolean][] = [];
  if (def.competencies.length) items.push(["Competency model", def.competenciesApproved !== false]);
  for (const s of def.stages) {
    items.push([`Stage · ${s.name}`, s.approved]);
    for (const q of s.questions) items.push([`Question · ${q.text.slice(0, 50)}`, q.approved]);
    for (const p of s.briefing ?? []) items.push([`Briefing · ${p.title}`, p.approved]);
  }
  for (const d of def.documents) items.push([`Document · ${d.label}`, d.approved]);
  items.push(["Offer model", def.offer.approved]);
  items.push(["Onboarding plan", def.onboarding.approved]);
  items.push(["Provisioning", def.provisioning.approved]);
  items.push(["Fairness configuration", def.fairness.approved]);
  return { approved: items.filter((i) => i[1]).length, total: items.length, pending: items.filter((i) => !i[1]).map((i) => i[0]) };
}

/** The shared validator, plus the competency model's own approval. */
export function studioIssues(def: StudioDefinition): Issue[] {
  const issues = validateBlueprint(def);
  if (def.competenciesApproved === false) issues.unshift({ level: "error", section: "competencies", where: "Competency model", message: "Not approved yet." });
  return issues;
}

