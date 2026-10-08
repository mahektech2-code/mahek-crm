import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { hireProfiles, hireSessions, hireStageExecutions, type HireCopilotEvent, type HireSegment, type HireSession, type HireStageExecution } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import type { BlueprintDefinition, Competency, Question, Stage } from "../blueprint-types";
import { isScored, stageByKey } from "../blueprint-types";
import { scopeWhere, type HireContext } from "../access";
import { aiState } from "../ai/orchestrator";
import { getApplication, type AppBundle } from "./core";

/* ---------------------------------------------------------------------------
 * Interviews: the list of who is being interviewed when, the AI voice screens
 * running or waiting for a person, and everything the interview workspace
 * reads to draw one interview.
 *
 * The workspace reads NO score. Prior-stage results contaminate an interview
 * (design brief §7.3), so nothing on this side of the scoring page selects
 * one — the earlier answers it loads are their WORDS, read for contradictions.
 * ------------------------------------------------------------------------- */

type Raw = Record<string, unknown>;

export type InterviewRow = {
  execId: string;
  applicationId: string;
  name: string;
  role: string;
  stage: string;
  interviewer: string | null;
  modality: string;
  status: string;
  sessionStatus: string | null;
  when: string | null;
  whenKind: "scheduled" | "started" | "completed" | "none";
  toConfirm: number;
};

export async function listHumanInterviews(ctx: HireContext): Promise<InterviewRow[]> {
  const rows = (await db.execute(sql`
    select x.id, x.application_id, x.stage_key, x.status, x.modality, x.scheduled_at, x.started_at, x.completed_at,
           c.full_name, b.title, b.definition, u.name as conductor,
           (select s.status from hire_sessions s where s.execution_id = x.id and s.modality <> 'ai_voice' order by s.started_at desc limit 1) as session_status,
           (select count(*)::int from hire_answers w where w.execution_id = x.id and w.superseded_by_id is null and w.confirmed_at is null) as to_confirm
    from hire_stage_executions x
    join hire_applications a on a.id = x.application_id
    join hire_candidates c on c.id = a.candidate_id
    join hire_blueprints b on b.id = a.blueprint_id
    left join users u on u.id = coalesce(x.conducted_by_id, a.interviewer_id)
    where ${scopeWhere(ctx)} and x.superseded_by_id is null
      and (x.status in ('scheduled','in_progress') or (x.status = 'not_started' and a.status = 'in_progress' and x.stage_key = a.stage_key)
           or (x.status = 'completed' and x.completed_at > now() - interval '14 days'))
      ${ctx.role === "interviewer" ? sql`and (x.conducted_by_id = ${ctx.user.id} or (x.conducted_by_id is null and a.interviewer_id = ${ctx.user.id}))` : sql``}
    order by coalesce(x.scheduled_at, x.started_at, x.completed_at, x.created_at) desc
    limit 300
  `)) as unknown as Raw[];
  const out: InterviewRow[] = [];
  for (const r of rows) {
    const def = r.definition as BlueprintDefinition;
    const st = stageByKey(def, String(r.stage_key));
    if (!st || !isScored(st) || st.type === "ai_screen") continue;
    const when = (r.completed_at ?? r.started_at ?? r.scheduled_at) as string | null;
    out.push({
      execId: String(r.id),
      applicationId: String(r.application_id),
      name: String(r.full_name),
      role: String(r.title),
      stage: st.name,
      interviewer: (r.conductor as string) ?? null,
      modality: (r.modality as string) ?? "in_person",
      status: String(r.status),
      sessionStatus: (r.session_status as string) ?? null,
      when: when ? new Date(when).toISOString() : null,
      whenKind: r.completed_at ? "completed" : r.started_at ? "started" : r.scheduled_at ? "scheduled" : "none",
      toConfirm: Number(r.to_confirm ?? 0),
    });
  }
  /* Today's work first: running, then scheduled soonest, then the rest. */
  const rank = (r: InterviewRow) => (r.status === "in_progress" ? 0 : r.status === "scheduled" ? 1 : r.status === "not_started" ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? (a.when ?? "").localeCompare(b.when ?? "") : (b.when ?? "").localeCompare(a.when ?? "")));
}

export type VoiceRow = {
  sessionId: string;
  execId: string;
  name: string;
  role: string;
  language: string;
  startedAt: string;
  endedAt: string | null;
  lastQuestion: string | null;
  lastSaid: string | null;
  toConfirm: number;
  escalated: string | null;
};

export async function listVoiceScreens(ctx: HireContext): Promise<{ live: VoiceRow[]; done: VoiceRow[] }> {
  const rows = (await db.execute(sql`
    select s.id, s.execution_id, s.status, s.language, s.started_at, s.ended_at, s.segments, s.escalated,
           c.full_name, b.title, b.definition, x.stage_key,
           (select count(*)::int from hire_answers w where w.execution_id = x.id and w.superseded_by_id is null and w.confirmed_at is null) as to_confirm
    from hire_sessions s
    join hire_stage_executions x on x.id = s.execution_id
    join hire_applications a on a.id = x.application_id
    join hire_candidates c on c.id = a.candidate_id
    join hire_blueprints b on b.id = a.blueprint_id
    where ${scopeWhere(ctx)} and s.modality = 'ai_voice' and x.superseded_by_id is null
      and (s.status = 'live' or (s.status = 'ended' and s.ended_at > now() - interval '30 days'))
    order by s.started_at desc limit 100
  `)) as unknown as Raw[];
  const live: VoiceRow[] = [];
  const done: VoiceRow[] = [];
  for (const r of rows) {
    const segs = (r.segments as HireSegment[]) ?? [];
    const def = r.definition as BlueprintDefinition;
    const st = stageByKey(def, String(r.stage_key));
    const lastAi = [...segs].reverse().find((s) => s.speaker !== "candidate");
    const lastCand = [...segs].reverse().find((s) => s.speaker === "candidate");
    const q = lastAi?.questionKey ? st?.questions.find((x) => x.key === lastAi.questionKey)?.text : lastAi?.text;
    const row: VoiceRow = {
      sessionId: String(r.id),
      execId: String(r.execution_id),
      name: String(r.full_name),
      role: String(r.title),
      language: (r.language as string) ?? "English",
      startedAt: new Date(r.started_at as string).toISOString(),
      endedAt: r.ended_at ? new Date(r.ended_at as string).toISOString() : null,
      lastQuestion: q ?? null,
      lastSaid: lastCand?.text ?? null,
      toConfirm: Number(r.to_confirm ?? 0),
      escalated: (r.escalated as string) ?? null,
    };
    if (r.status === "live") live.push(row);
    else if (row.toConfirm > 0) done.push(row);
  }
  return { live, done };
}

export type VoiceSetup = {
  languages: string[];
  callWindow: string;
  maxAttempts: number;
  aiOn: boolean;
  aiWhy: string | null;
  blueprints: { title: string; version: number; stage: string; questions: { text: string; competency: string; mode: string }[] }[];
};

export async function voiceSetup(): Promise<VoiceSetup> {
  const [c, ai] = await Promise.all([getConfig(), aiState()]);
  const bps = (await db.execute(sql`select title, version, definition from hire_blueprints where status = 'published' order by title`)) as unknown as Raw[];
  return {
    languages: c["hire.languages"].split(",").map((s) => s.trim()).filter(Boolean),
    callWindow: c["hire.voice.callWindow"],
    maxAttempts: c["hire.voice.maxAttempts"],
    aiOn: ai.on,
    aiWhy: ai.on ? null : ai.reason,
    blueprints: bps.flatMap((b) => {
      const def = b.definition as BlueprintDefinition;
      const st = def.stages.find((s) => s.type === "ai_screen");
      if (!st) return [];
      return [
        {
          title: String(b.title),
          version: Number(b.version),
          stage: st.name,
          questions: st.questions.map((q) => ({ text: q.text, competency: def.competencies.find((x) => x.key === q.competencyKeys[0])?.name ?? "—", mode: q.mode })),
        },
      ];
    }),
  };
}

/* --------------------------------------------------------------- workspace */

export type WorkspaceData = {
  bundle: AppBundle;
  exec: HireStageExecution;
  stage: Stage;
  questions: Question[];
  competencies: Competency[];
  session: HireSession | null;
  /** A live AI voice screen on this execution that a person could take over. */
  aiLive: { id: string } | null;
  conductor: string;
  aiOn: boolean;
  aiWhy: string | null;
};

export async function loadWorkspace(ctx: HireContext, execId: string): Promise<WorkspaceData | null> {
  const [exec] = await db.select().from(hireStageExecutions).where(eq(hireStageExecutions.id, execId)).limit(1);
  if (!exec || exec.supersededById) return null;
  const bundle = await getApplication(ctx, exec.applicationId);
  if (!bundle) return null;
  if (ctx.role === "interviewer" && exec.conductedById && exec.conductedById !== ctx.user.id) return null;
  const stage = stageByKey(bundle.def, exec.stageKey);
  if (!stage || !isScored(stage)) return null;
  const sessions = await db.select().from(hireSessions).where(eq(hireSessions.executionId, execId)).orderBy(desc(hireSessions.startedAt));
  const human = sessions.find((s) => s.modality !== "ai_voice" && s.status !== "abandoned") ?? null;
  const aiLive = sessions.find((s) => s.modality === "ai_voice" && s.status === "live") ?? null;
  const ai = await aiState();
  let conductor = ctx.user.name;
  if (exec.conductedById && exec.conductedById !== ctx.user.id) {
    const [r] = (await db.execute(sql`select name from users where id = ${exec.conductedById}`)) as unknown as { name: string }[];
    conductor = r?.name ?? conductor;
  }
  return {
    bundle,
    exec,
    stage,
    questions: stage.questions,
    competencies: bundle.def.competencies,
    session: human,
    aiLive: aiLive ? { id: aiLive.id } : null,
    conductor,
    aiOn: ai.on,
    aiWhy: ai.on ? null : ai.reason,
  };
}

/**
 * What the copilot may check the candidate against: the CV's claims and what
 * they said at EARLIER stages — their words with the source, never a score.
 */
export async function contradictionSources(applicationId: string, excludeExecId: string): Promise<{ text: string; source: string }[]> {
  const out: { text: string; source: string }[] = [];
  const [p] = await db.select({ data: hireProfiles.data }).from(hireProfiles).where(eq(hireProfiles.applicationId, applicationId)).limit(1);
  if (p) {
    for (const e of p.data.employers ?? []) out.push({ text: `${e.name} · ${e.title} · ${e.from} – ${e.to}${e.months ? ` (${e.months} months)` : ""}`, source: "CV" });
    for (const [k, f] of Object.entries(p.data.fields ?? {})) out.push({ text: `${k}: ${f.value}`, source: "CV" });
  }
  const rows = (await db.execute(sql`
    select w.question_key, w.response_text, x.stage_key, b.definition
    from hire_answers w
    join hire_stage_executions x on x.id = w.execution_id
    join hire_applications a on a.id = x.application_id
    join hire_blueprints b on b.id = a.blueprint_id
    where x.application_id = ${applicationId} and x.id <> ${excludeExecId}
      and w.superseded_by_id is null and x.superseded_by_id is null and w.response_text is not null
      and w.scored_by is distinct from 'fixed_choice' and w.scored_by is distinct from 'calculated'
    order by w.created_at limit 40
  `)) as unknown as Raw[];
  for (const r of rows) {
    const def = r.definition as BlueprintDefinition;
    const st = stageByKey(def, String(r.stage_key));
    out.push({ text: String(r.response_text), source: `${st?.name ?? r.stage_key} · ${String(r.question_key).toUpperCase()}` });
  }
  return out;
}

export async function liveSession(execId: string): Promise<HireSession | null> {
  const [s] = await db
    .select()
    .from(hireSessions)
    .where(and(eq(hireSessions.executionId, execId), eq(hireSessions.status, "live"), sql`${hireSessions.modality} <> 'ai_voice'`))
    .orderBy(desc(hireSessions.startedAt))
    .limit(1);
  return s ?? null;
}

export type { HireCopilotEvent };
