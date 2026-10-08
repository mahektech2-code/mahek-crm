import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { scopeWhere, seesScores, type HireContext } from "../access";
import { istAt, istYmd, addYmd } from "./schedule";

/* ---------------------------------------------------------------------------
 * What is waiting on this person, oldest first. Everything here is DERIVED
 * from the records in their scope — there is no task table to fall out of
 * step with the work. Each task points at the screen where it is done.
 * ------------------------------------------------------------------------- */

export type TaskKind = "duplicate" | "screen" | "review" | "proposal" | "gate" | "interview" | "sla";

export type HireTask = {
  key: string;
  kind: TaskKind;
  title: string;
  meta: string;
  href: string;
  /** When it started waiting. */
  sinceIso: string;
  /** Past its window — drawn red. */
  overdue: boolean;
  applicationId: string;
};

export const TASK_GROUP: Record<TaskKind, string> = {
  duplicate: "Possible duplicates to decide",
  screen: "Applications to screen in",
  review: "AI scores to confirm",
  proposal: "Rejections to confirm",
  gate: "Decisions waiting at a gate",
  interview: "Your interviews today",
  sla: "Past the stage target",
};

type Raw = Record<string, unknown>;

export async function tasksFor(ctx: HireContext, nowMs: number): Promise<HireTask[]> {
  const scope = scopeWhere(ctx);
  const out: HireTask[] = [];
  const iso = (v: unknown) => new Date(v as string).toISOString();

  if (ctx.can("addCandidate") || ctx.can("override")) {
    const dups = (await db.execute(sql`
      select a.id, c.full_name, b.title, a.applied_at, a.duplicate from hire_applications a
      join hire_candidates c on c.id = a.candidate_id join hire_blueprints b on b.id = a.blueprint_id
      where ${scope} and a.status = 'in_progress' and (a.duplicate->>'status') = 'open'`)) as unknown as Raw[];
    for (const r of dups) {
      const d = r.duplicate as { confidence?: string; why?: string };
      out.push({ key: `dup:${r.id}`, kind: "duplicate", title: `${r.full_name} may already be in Hire`, meta: `${r.title} · ${d.confidence ?? ""} match · ${d.why ?? ""}`, href: `/hire/c/${r.id}`, sinceIso: iso(r.applied_at), overdue: false, applicationId: String(r.id) });
    }
    const screen = (await db.execute(sql`
      select a.id, c.full_name, b.title, a.location, a.stage_entered_at from hire_applications a
      join hire_candidates c on c.id = a.candidate_id join hire_blueprints b on b.id = a.blueprint_id
      where ${scope} and a.status = 'in_progress' and coalesce(a.duplicate->>'status', '') <> 'open'
        and exists (select 1 from jsonb_array_elements(b.definition->'stages') s where s->>'key' = a.stage_key and s->>'type' = 'application')
        and not exists (select 1 from hire_stage_executions x where x.application_id = a.id and x.stage_key = a.stage_key and x.superseded_by_id is null and x.outcome = 'pass')`)) as unknown as Raw[];
    for (const r of screen)
      out.push({ key: `scr:${r.id}`, kind: "screen", title: `Review ${r.full_name}’s application`, meta: [r.title, r.location].filter(Boolean).join(" · "), href: `/hire/c/${r.id}`, sinceIso: iso(r.stage_entered_at), overdue: nowMs - new Date(r.stage_entered_at as string).getTime() > 24 * 3_600_000, applicationId: String(r.id) });
  }

  if (ctx.can("score")) {
    const review = (await db.execute(sql`
      select x.id as exec_id, a.id, c.full_name, b.title, b.definition, x.stage_key, count(*)::int as n, min(w.created_at) as since
      from hire_answers w
      join hire_stage_executions x on x.id = w.execution_id
      join hire_applications a on a.id = x.application_id
      join hire_candidates c on c.id = a.candidate_id join hire_blueprints b on b.id = a.blueprint_id
      where ${scope} and x.superseded_by_id is null and w.superseded_by_id is null and w.ai_score is not null and w.confirmed_at is null
        ${ctx.role === "interviewer" ? sql`and (x.conducted_by_id = ${ctx.user.id} or a.interviewer_id = ${ctx.user.id})` : sql``}
      group by x.id, a.id, c.full_name, b.title, b.definition, x.stage_key`)) as unknown as Raw[];
    for (const r of review) {
      const def = r.definition as { stages: { key: string; name: string }[] };
      out.push({
        key: `rev:${r.exec_id}`,
        kind: "review",
        title: `Confirm ${r.n} AI score${Number(r.n) === 1 ? "" : "s"} for ${r.full_name}`,
        meta: `${r.title} · ${def.stages.find((s) => s.key === r.stage_key)?.name ?? r.stage_key} · nothing counts until a person confirms`,
        href: `/hire/scoring/${r.exec_id}`,
        sinceIso: iso(r.since),
        overdue: nowMs - new Date(r.since as string).getTime() > 24 * 3_600_000,
        applicationId: String(r.id),
      });
    }
  }

  if (ctx.can("confirmReject")) {
    const props = (await db.execute(sql`
      select p.id as pid, a.id, c.full_name, b.title, b.definition, p.stage_key, p.score, p.proposed_at, p.window_ends_at
      from hire_rejection_proposals p
      join hire_applications a on a.id = p.application_id
      join hire_candidates c on c.id = a.candidate_id join hire_blueprints b on b.id = a.blueprint_id
      where ${scope} and p.status = 'open'`)) as unknown as Raw[];
    for (const r of props) {
      const def = r.definition as { stages: { key: string; name: string }[] };
      const showScore = seesScores(ctx) && r.score != null;
      out.push({
        key: `rej:${r.pid}`,
        kind: "proposal",
        title: `Confirm or dismiss the rejection of ${r.full_name}`,
        meta: `${r.title} · ${def.stages.find((s) => s.key === r.stage_key)?.name ?? r.stage_key}${showScore ? ` · scored ${Math.round(Number(r.score))}` : ""} · window ends ${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" }).format(new Date(r.window_ends_at as string))}`,
        href: `/hire/decisions`,
        sinceIso: iso(r.proposed_at),
        overdue: new Date(r.window_ends_at as string).getTime() < nowMs,
        applicationId: String(r.id),
      });
    }
  }

  if (ctx.can("decide")) {
    const gates = (await db.execute(sql`
      select a.id, c.full_name, b.title, a.stage_entered_at, a.location from hire_applications a
      join hire_candidates c on c.id = a.candidate_id join hire_blueprints b on b.id = a.blueprint_id
      where ${scope} and a.status = 'in_progress'
        and exists (select 1 from jsonb_array_elements(b.definition->'stages') s where s->>'key' = a.stage_key and s->>'type' = 'decision_gate')`)) as unknown as Raw[];
    for (const r of gates)
      out.push({ key: `gate:${r.id}`, kind: "gate", title: `Decide on ${r.full_name}`, meta: [r.title, r.location, "a named person records the decision and why"].filter(Boolean).join(" · "), href: `/hire/gate/${r.id}`, sinceIso: iso(r.stage_entered_at), overdue: nowMs - new Date(r.stage_entered_at as string).getTime() > 24 * 3_600_000, applicationId: String(r.id) });
  }

  {
    const today = istYmd(nowMs);
    const ivs = (await db.execute(sql`
      select x.id as exec_id, a.id, c.full_name, b.title, b.definition, x.stage_key, x.scheduled_at, x.place from hire_stage_executions x
      join hire_applications a on a.id = x.application_id
      join hire_candidates c on c.id = a.candidate_id join hire_blueprints b on b.id = a.blueprint_id
      where x.conducted_by_id = ${ctx.user.id} and x.superseded_by_id is null and x.status in ('scheduled','in_progress')
        and x.scheduled_at >= ${istAt(today, 0).toISOString()}::timestamptz and x.scheduled_at < ${istAt(addYmd(today, 1), 0).toISOString()}::timestamptz`)) as unknown as Raw[];
    for (const r of ivs) {
      const def = r.definition as { stages: { key: string; name: string }[] };
      const at = new Date(r.scheduled_at as string);
      out.push({
        key: `iv:${r.exec_id}`,
        kind: "interview",
        title: `${def.stages.find((s) => s.key === r.stage_key)?.name ?? r.stage_key} with ${r.full_name}`,
        meta: `${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(at)} · ${r.title}${r.place ? ` · ${r.place}` : ""}`,
        href: `/hire/workspace/${r.exec_id}`,
        sinceIso: at.toISOString(),
        overdue: false,
        applicationId: String(r.id),
      });
    }
  }

  if (ctx.role !== "interviewer") {
    const rows = (await db.execute(sql`
      select a.id, c.full_name, b.title, b.definition, a.stage_key, a.stage_entered_at from hire_applications a
      join hire_candidates c on c.id = a.candidate_id join hire_blueprints b on b.id = a.blueprint_id
      where ${scope} and a.status = 'in_progress'`)) as unknown as Raw[];
    for (const r of rows) {
      const def = r.definition as { stages: { key: string; name: string; slaHours: number; type: string }[] };
      const st = def.stages.find((s) => s.key === r.stage_key);
      if (!st || !st.slaHours) continue;
      const entered = new Date(r.stage_entered_at as string).getTime();
      const hrs = (nowMs - entered) / 3_600_000;
      if (hrs <= st.slaHours) continue;
      /* Gates and screen-ins are already listed above with their own action. */
      if (st.type === "decision_gate" || st.type === "application") continue;
      out.push({
        key: `sla:${r.id}`,
        kind: "sla",
        title: `${r.full_name} has been in ${st.name} for ${hrs < 48 ? `${Math.round(hrs)}h` : `${Math.floor(hrs / 24)}d`}`,
        meta: `${r.title} · target ${st.slaHours < 48 ? `${st.slaHours}h` : `${Math.round(st.slaHours / 24)}d`}`,
        href: `/hire/c/${r.id}`,
        sinceIso: new Date(entered + st.slaHours * 3_600_000).toISOString(),
        overdue: true,
        applicationId: String(r.id),
      });
    }
  }

  return out.sort((a, b) => a.sinceIso.localeCompare(b.sinceIso));
}
