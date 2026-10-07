import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { hireApplications, hireStageExecutions } from "@/db/schema";
import { notifyUsers } from "@/lib/notify";
import { err, ok, type Result } from "@/lib/result";
import { isScored } from "../blueprint-types";
import { scopeWhere, type HireContext } from "../access";
import { audit, ensureExecution, type AppBundle } from "./core";

/* ---------------------------------------------------------------------------
 * Interviews on a calendar. Times are proposed by a plain rule — the first
 * free working slot on each of the next days, around the interviewer's and
 * the candidate's existing bookings — and NOTHING is booked until a person
 * confirms one (design: the scheduling agent never books on its own).
 *
 * Every wall-clock time here is IST, spelled with its offset.
 * ------------------------------------------------------------------------- */

const TZ = "Asia/Kolkata";
export const DAY_START = 10;
export const DAY_END = 18;

/** "2026-10-07" — the IST date of an instant. */
export function istYmd(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** An IST wall-clock time on a date, as an instant. */
export const istAt = (ymd: string, h: number, m = 0) => new Date(`${ymd}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+05:30`);

/** Add days to a YYYY-MM-DD date, calendar-wise. */
export function addYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for an IST date. */
export const weekday = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

/** The Monday of the week an IST date falls in. */
export function mondayOf(ymd: string): string {
  const wd = weekday(ymd);
  return addYmd(ymd, wd === 0 ? -6 : 1 - wd);
}

export type Slot = { startIso: string; minutes: number };

type Busy = { id: string; start: number; end: number };

async function busyFor(interviewerId: string, applicationId: string, fromIso: string, toIso: string): Promise<Busy[]> {
  const rows = (await db.execute(sql`
    select x.id, x.scheduled_at, coalesce(x.scheduled_minutes, 45) as minutes
    from hire_stage_executions x
    where x.superseded_by_id is null and x.status in ('scheduled','in_progress') and x.scheduled_at is not null
      and x.scheduled_at >= ${fromIso}::timestamptz and x.scheduled_at < ${toIso}::timestamptz
      and (x.conducted_by_id = ${interviewerId} or x.application_id = ${applicationId})`)) as unknown as { id: string; scheduled_at: string; minutes: number | string }[];
  return rows.map((r) => {
    const start = new Date(r.scheduled_at).getTime();
    return { id: String(r.id), start, end: start + Number(r.minutes) * 60_000 };
  });
}

/** Three proposals: the first free slot on each of the next working days. */
export async function suggestSlots(a: { applicationId: string; interviewerId: string; minutes: number; fromMs: number }): Promise<Slot[]> {
  const minutes = Math.min(180, Math.max(15, Math.round(a.minutes)));
  const earliest = a.fromMs + 2 * 3_600_000;
  const startYmd = istYmd(a.fromMs);
  const busy = await busyFor(a.interviewerId, a.applicationId, new Date(a.fromMs).toISOString(), new Date(a.fromMs + 21 * 86_400_000).toISOString());
  const out: Slot[] = [];
  for (let d = 0; d < 21 && out.length < 3; d++) {
    const ymd = addYmd(startYmd, d);
    if (weekday(ymd) === 0) continue;
    for (let mins = DAY_START * 60; mins + minutes <= DAY_END * 60; mins += 30) {
      const s = istAt(ymd, Math.floor(mins / 60), mins % 60).getTime();
      const e = s + minutes * 60_000;
      if (s < earliest) continue;
      if (busy.some((b) => s < b.end && e > b.start)) continue;
      out.push({ startIso: new Date(s).toISOString(), minutes });
      break;
    }
  }
  return out;
}

export async function bookInterview(
  ctx: HireContext,
  b: AppBundle,
  input: { interviewerId: string; startIso: string; minutes: number; place: string; modality: string },
): Promise<Result> {
  const stage = b.stage;
  if (!stage || !isScored(stage) || stage.type === "ai_screen") return err("Only a scored interview stage is booked on the calendar. The AI screen runs from Interviews.", "rule_violation");
  if (b.app.status !== "in_progress") return err("This application is not in progress.", "rule_violation");
  const start = new Date(input.startIso);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "Choose a date and time.", code: "validation", fieldErrors: [{ field: "when", message: "Required" }] };
  if (start.getTime() < Date.now()) return { ok: false, error: "That time has already passed.", code: "validation", fieldErrors: [{ field: "when", message: "In the past" }] };
  const minutes = Math.round(input.minutes);
  if (!(minutes >= 15 && minutes <= 180)) return { ok: false, error: "An interview is between 15 and 180 minutes.", code: "validation", fieldErrors: [{ field: "minutes", message: "15–180" }] };
  const [person] = (await db.execute(sql`select u.name from users u join app_access g on g.user_id = u.id and g.app = 'hire' where u.id = ${input.interviewerId}`)) as unknown as { name: string }[];
  if (!person) return { ok: false, error: "The interviewer must hold Hire.", code: "validation", fieldErrors: [{ field: "interviewer", message: "Not a Hire user" }] };
  const end = start.getTime() + minutes * 60_000;
  const busy = await busyFor(input.interviewerId, b.app.id, new Date(start.getTime() - 4 * 3_600_000).toISOString(), new Date(end).toISOString());
  const exec = await ensureExecution(b.app.id, stage, ctx.user.id);
  /* Rebooking this stage moves its own booking; it never clashes with itself. */
  const clash = busy.some((x) => x.id !== exec.id && start.getTime() < x.end && end > x.start);
  if (clash) return err(`${person.name} or ${b.candidate.fullName} already has an interview at that time.`, "conflict");
  if (exec.status === "completed" || exec.status === "in_progress") return err(`${stage.name} has already started.`, "rule_violation");

  const when = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(start);
  const before = { scheduledAt: exec.scheduledAt, conductedById: exec.conductedById };
  await db
    .update(hireStageExecutions)
    .set({ status: "scheduled", scheduledAt: start, scheduledMinutes: minutes, place: input.place.trim() || null, modality: input.modality || "in_person", conductedById: input.interviewerId, updatedAt: new Date(), updatedById: ctx.user.id })
    .where(eq(hireStageExecutions.id, exec.id));
  await db.update(hireApplications).set({ interviewerId: input.interviewerId, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hireApplications.id, b.app.id));
  await audit(ctx, {
    applicationId: b.app.id,
    candidateId: b.candidate.id,
    entityType: "stage",
    entityId: exec.id,
    eventType: before.scheduledAt ? "rescheduled" : "scheduled",
    summary: `${stage.name} booked for ${when} IST with ${person.name} · ${minutes} min${input.place.trim() ? ` · ${input.place.trim()}` : ""} · confirmed by a person`,
    before,
    after: { scheduledAt: start.toISOString(), conductedById: input.interviewerId },
  });
  if (input.interviewerId !== ctx.user.id)
    await notifyUsers([{ userId: input.interviewerId, title: `Interview booked: ${b.candidate.fullName}`, body: `${stage.name} · ${b.blueprint.title} · ${when} IST`, href: `/hire/calendar`, kind: "info" }]);
  return ok(undefined, `${stage.name} booked for ${when}.`);
}

export type CalEvent = {
  execId: string;
  applicationId: string;
  name: string;
  role: string;
  stage: string;
  startIso: string;
  minutes: number;
  interviewer: string | null;
  place: string | null;
  status: string;
  mine: boolean;
};

/** Interviews booked in a week (Mon–Sat), in this person's scope. */
export async function weekEvents(ctx: HireContext, monday: string): Promise<CalEvent[]> {
  const from = istAt(monday, 0).toISOString();
  const to = istAt(addYmd(monday, 7), 0).toISOString();
  const rows = (await db.execute(sql`
    select x.id, x.application_id, c.full_name, b.title, b.definition, x.stage_key, x.scheduled_at, coalesce(x.scheduled_minutes, 45) as minutes,
           u.name as interviewer, x.place, x.status, x.conducted_by_id
    from hire_stage_executions x
    join hire_applications a on a.id = x.application_id
    join hire_candidates c on c.id = a.candidate_id
    join hire_blueprints b on b.id = a.blueprint_id
    left join users u on u.id = x.conducted_by_id
    where ${scopeWhere(ctx)} and x.superseded_by_id is null and x.scheduled_at is not null
      and x.status in ('scheduled','in_progress','completed')
      and x.scheduled_at >= ${from}::timestamptz and x.scheduled_at < ${to}::timestamptz
    order by x.scheduled_at`)) as unknown as Record<string, unknown>[];
  return rows.map((r) => {
    const def = r.definition as { stages: { key: string; name: string }[] };
    return {
      execId: String(r.id),
      applicationId: String(r.application_id),
      name: String(r.full_name),
      role: String(r.title),
      stage: def.stages.find((s) => s.key === r.stage_key)?.name ?? String(r.stage_key),
      startIso: new Date(r.scheduled_at as string).toISOString(),
      minutes: Number(r.minutes),
      interviewer: (r.interviewer as string) ?? null,
      place: (r.place as string) ?? null,
      status: String(r.status),
      mine: r.conducted_by_id === ctx.user.id,
    };
  });
}

export type ToSchedule = { applicationId: string; name: string; role: string; stage: string; location: string | null; interviewerId: string | null; waitingHours: number };

/** Applications sitting in a scored interview stage with nothing booked. */
export async function toSchedule(ctx: HireContext, nowMs: number): Promise<ToSchedule[]> {
  const rows = (await db.execute(sql`
    select a.id, c.full_name, b.title, b.definition, a.stage_key, a.location, a.interviewer_id, a.stage_entered_at
    from hire_applications a
    join hire_candidates c on c.id = a.candidate_id
    join hire_blueprints b on b.id = a.blueprint_id
    where ${scopeWhere(ctx)} and a.status = 'in_progress'
      and not exists (select 1 from hire_stage_executions x where x.application_id = a.id and x.stage_key = a.stage_key
                        and x.superseded_by_id is null and (x.status in ('scheduled','in_progress','completed') or x.final_score is not null))
    order by a.stage_entered_at`)) as unknown as Record<string, unknown>[];
  const out: ToSchedule[] = [];
  for (const r of rows) {
    const def = r.definition as import("../blueprint-types").BlueprintDefinition;
    const st = def.stages.find((s) => s.key === r.stage_key);
    if (!st || !isScored(st) || st.type === "ai_screen") continue;
    out.push({
      applicationId: String(r.id),
      name: String(r.full_name),
      role: String(r.title),
      stage: st.name,
      location: (r.location as string) ?? null,
      interviewerId: (r.interviewer_id as string) ?? null,
      waitingHours: Math.round((nowMs - new Date(r.stage_entered_at as string).getTime()) / 3_600_000),
    });
  }
  return out;
}

/** People who can conduct an interview: everybody holding Hire. */
export async function hireStaff(): Promise<{ id: string; name: string; role: string | null }[]> {
  const rows = (await db.execute(sql`
    select u.id, u.name, r.role from users u join app_access g on g.user_id = u.id and g.app = 'hire'
    left join hire_user_roles r on r.user_id = u.id
    where u.active is not false order by u.name`)) as unknown as { id: string; name: string; role: string | null }[];
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), role: r.role ?? null }));
}
