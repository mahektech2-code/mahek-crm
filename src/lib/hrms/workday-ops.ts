import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { hrmsAttendance, hrmsOffices, hrmsWorkdayClaims, type HrmsAttendance } from "@/db/schema";
import { err, ok, okVoid, type Result } from "@/lib/result";
import { has, managesFor, type HrmsContext } from "./access";
import { hrmsAudit, hrmsId, today, first } from "./server";
import { attendanceCfg } from "./services/attendance";
import { decideCheckIn, type CheckInRefusal } from "./engines/attendance";
import { closeFromBreak, endSession, openSession, phaseOf, startSession, type WorkdayPhase, type WorkdaySession } from "./engines/workday";
import { approvedSpans, forgetLock, mirrorPatch, sessionsOf, settledToday, workdayCfg } from "./services/workday";
import { metresBetween, nowHM } from "./time";
import { managerUserIdsOf, powerHolderUserIds, usersOfEmployees } from "./services/notify";
import { notifyUsers } from "@/lib/notify";
import { hrmsLink } from "./registry";

/* ---------------------------------------------------------------------------
 * THE WORKDAY'S WRITES that are not the first punch-in or the punch-out
 * (those stay `hrmsCheckIn` / `hrmsCheckOut`, which keep every rule they had).
 * Plain functions taking the HRMS context, called from `/api/workday` — a
 * route, not a server action, because the server refuses server actions while
 * somebody is locked and these are the way out of the lock.
 * ------------------------------------------------------------------------- */

export type WorkdayResult = Result<{ refusal?: CheckInRefusal; message?: string; detail?: string }>;
type Fix = { lat: number | null; lng: number | null; accuracy?: number | null };

const hhmm = (ms: number) => nowHM(new Date(ms));

async function todayRow(ctx: HrmsContext): Promise<HrmsAttendance | null> {
  if (!ctx.employee) return null;
  return settledToday(ctx.employee.id);
}

async function write(ctx: HrmsContext, row: HrmsAttendance, sessions: WorkdaySession[], extra: Partial<HrmsAttendance> = {}) {
  const now = Date.now();
  const patch = mirrorPatch(sessions, now, await approvedSpans(row.id));
  await db
    .update(hrmsAttendance)
    .set({ ...patch, ...extra, updatedById: ctx.user.id })
    .where(eq(hrmsAttendance.id, row.id));
  forgetLock(ctx.user.id);
}

/**
 * Back at work after a punch-out, an automatic punch-out or a break. After a
 * punch-out the office location is checked again, exactly as in the morning —
 * otherwise somebody punched out at three could punch back in from home. From
 * a break nothing is asked: the break was taken at the desk.
 */
export async function punchInAgain(
  ctx: HrmsContext,
  row: HrmsAttendance,
  sessions: WorkdaySession[],
  phase: WorkdayPhase,
  fix: Fix,
  office: typeof hrmsOffices.$inferSelect | null,
): Promise<WorkdayResult> {
  const me = ctx.employee!;
  const now = Date.now();
  if (phase === "done" || phase === "auto_out") {
    const cfg = await attendanceCfg();
    const hasPin = office?.lat != null && office?.lng != null;
    const distanceM = fix.lat != null && fix.lng != null && hasPin ? metresBetween({ lat: fix.lat, lng: fix.lng }, { lat: office!.lat!, lng: office!.lng! }) : fix.lat == null ? null : 0;
    const d = decideCheckIn({
      alreadyToday: false,
      distanceM,
      officeHasPin: hasPin,
      officeName: office?.name ?? me.office ?? "your office",
      radiusM: office?.radiusM ?? 200,
      privileged: has(ctx, "hr") || ctx.administrator,
      privilegedRangeM: cfg.privilegedRangeM,
      /* Lateness was settled by the morning's punch-in. */
      officialIn: null,
      now: hhmm(now),
      graceMinutes: cfg.graceMinutes,
      name: me.name,
    });
    if (!d.ok) return ok({ refusal: d.reason, message: d.message, detail: d.detail });
  }
  const next = startSession(sessions, now);
  if (!next) return ok({ refusal: "already", message: "You are already at work", detail: "" });
  await write(ctx, row, next, { lastActivityAt: new Date(now) });
  await hrmsAudit(ctx, "hrms.workday.resume", "hrms_attendance", row.id, null, { from: phase, at: hhmm(now) });
  return ok({}, phase === "break" || phase === "auto_break" ? `Back at work at ${hhmm(now)}` : `Punched in again at ${hhmm(now)} · the time away is not counted`);
}

/** Start a break. The reason is optional and no reason has a limit of its own. */
export async function startBreak(ctx: HrmsContext, reason: string | null): Promise<WorkdayResult> {
  const row = await todayRow(ctx);
  if (!row) return err("You have not punched in today.");
  const s = sessionsOf(row);
  if (!openSession(s)) return err("You are not working right now, so there is no break to start.");
  const cfg = await workdayCfg();
  const why = reason?.trim() ? reason.trim().slice(0, 80) : null;
  if (why && !cfg.breakReasons.includes(why) && why.length > 80) return err("That reason is too long.");
  const now = Date.now();
  const next = endSession(s, now, "break", why)!;
  await write(ctx, row, next);
  await hrmsAudit(ctx, "hrms.workday.break", "hrms_attendance", row.id, null, { at: hhmm(now), reason: why });
  return ok({}, `On a break since ${hhmm(now)}`);
}

/**
 * Resume from a break or an automatic break. A claim that an automatic break
 * was really work rides with it: it goes to the manager and nothing changes
 * until they decide.
 */
export async function resumeWork(ctx: HrmsContext, claim: { category: string; note: string } | null): Promise<WorkdayResult> {
  const row = await todayRow(ctx);
  if (!row) return err("You have not punched in today.");
  const s = sessionsOf(row);
  const phase = phaseOf(s);
  if (phase !== "break" && phase !== "auto_break") return err("You are not on a break.");
  const last = s[s.length - 1];
  const now = Date.now();
  if (claim) {
    if (phase !== "auto_break") return err("Only an automatic break can be claimed as work.");
    const r = await raiseClaim(ctx, row, "auto_break", last.out!, now, claim);
    if (!r.ok) return r;
  }
  return punchInAgain(ctx, row, s, phase, { lat: null, lng: null }, null);
}

/** Punch out from a break: the day ends where the break began. */
export async function punchOutFromBreak(ctx: HrmsContext): Promise<WorkdayResult> {
  const row = await todayRow(ctx);
  if (!row) return err("You have not punched in today.");
  const s = sessionsOf(row);
  const closed = closeFromBreak(s);
  if (!closed) return err("You are not on a break.");
  await write(ctx, row, closed);
  const out = closed[closed.length - 1].out!;
  await hrmsAudit(ctx, "hrms.workday.punchOut", "hrms_attendance", row.id, null, { at: hhmm(out), fromBreak: true });
  return ok({}, `Punched out at ${hhmm(out)}, when your break began`);
}

/**
 * Somebody is active. Written at most once a minute per person (the browser
 * already holds back), and only while a stretch is running — activity during
 * a break is not evidence of work.
 */
export async function beat(ctx: HrmsContext): Promise<void> {
  if (!ctx.employee) return;
  const [row] = await db
    .select({ id: hrmsAttendance.id, sessions: hrmsAttendance.sessions, date: hrmsAttendance.date, checkIn: hrmsAttendance.checkIn, checkOut: hrmsAttendance.checkOut, lastActivityAt: hrmsAttendance.lastActivityAt })
    .from(hrmsAttendance)
    .where(and(eq(hrmsAttendance.employeeId, ctx.employee.id), eq(hrmsAttendance.date, today())));
  if (!row) return;
  /* Settle FIRST: a beat that arrives after an hour of nothing must not
     reach back and turn the hour into work. */
  const settled = await settledToday(ctx.employee.id);
  if (!settled || phaseOf(sessionsOf(settled)) !== "working") return;
  await db.update(hrmsAttendance).set({ lastActivityAt: new Date() }).where(eq(hrmsAttendance.id, row.id));
}

/** "I was working away from the screen" for the day's last automatic punch-out. */
export async function claimAutoOut(ctx: HrmsContext, claim: { category: string; note: string }): Promise<WorkdayResult> {
  const row = await todayRow(ctx);
  if (!row) return err("You have not punched in today.");
  const s = sessionsOf(row);
  if (phaseOf(s) !== "auto_out") return err("Your day was not closed automatically.");
  const last = s[s.length - 1];
  const r = await raiseClaim(ctx, row, "auto_out", last.out!, Date.now(), claim);
  if (!r.ok) return r;
  return ok({}, "Sent to your manager. Until they decide, the time stays as a break.");
}

async function raiseClaim(ctx: HrmsContext, row: HrmsAttendance, kind: "auto_break" | "auto_out", from: number, to: number, claim: { category: string; note: string }): Promise<Result<undefined>> {
  const note = claim.note.trim();
  if (!note) return err("Write what you were doing.", "validation", [{ field: "note", message: "Write what you were doing." }]);
  if (to - from < 60_000) return err("There is less than a minute to claim.");
  const id = hrmsId("hwdc");
  await db.insert(hrmsWorkdayClaims).values({
    id,
    attendanceId: row.id,
    employeeId: row.employeeId,
    date: row.date,
    fromAt: new Date(from),
    toAt: new Date(to),
    kind,
    category: claim.category.trim().slice(0, 60) || "Other",
    note: note.slice(0, 500),
  });
  await hrmsAudit(ctx, "hrms.workday.claim", "hrms_workday_claims", id, null, { from: hhmm(from), to: hhmm(to), kind });
  await tellManagers(ctx, row.employeeId, {
    title: `${ctx.employee?.name ?? "Somebody"} says they were working`,
    body: `${hhmm(from)}–${hhmm(to)} was recorded as ${kind === "auto_out" ? "away after an automatic punch-out" : "an automatic break"}. ${claim.category}: ${note}`,
    href: hrmsLink("attendance", { view: "workdayClaims" }),
  });
  return okVoid();
}

/** Tell whoever manages this person (the org chart's manager, else HR). */
async function tellManagers(ctx: HrmsContext, employeeId: string, msg: { title: string; body: string; href: string }) {
  let ids = await managerUserIdsOf(employeeId);
  if (!ids.length) ids = await powerHolderUserIds("editAtt");
  await notifyUsers(ids.filter((id) => id !== ctx.user.id).map((userId) => ({ userId, ...msg, kind: "warn" })));
}

/** A manager decides a claim. Approving counts the span as work and rebuilds the day. */
export async function decideClaim(ctx: HrmsContext, id: string, approve: boolean, note: string): Promise<Result<undefined>> {
  const [c] = await db.select().from(hrmsWorkdayClaims).where(eq(hrmsWorkdayClaims.id, id));
  if (!c) return err("That claim no longer exists.");
  if (c.status !== "pending") return err(`That claim was already ${c.status}.`);
  const allowed = has(ctx, "editAtt") || ctx.administrator || managesFor(ctx, c.employeeId);
  if (!allowed) return err("Only this person's manager or HR can decide their claims.", "not_permitted");
  if (ctx.employee?.id === c.employeeId) return err("Somebody else decides your own claims.", "not_permitted");
  if (!approve && !note.trim()) return err("Say why it stays a break.", "validation", [{ field: "note", message: "Say why it stays a break." }]);
  await db
    .update(hrmsWorkdayClaims)
    .set({ status: approve ? "approved" : "declined", decidedById: ctx.user.id, decidedAt: new Date(), decidedNote: note.trim() || null })
    .where(eq(hrmsWorkdayClaims.id, id));
  const [row] = await db.select().from(hrmsAttendance).where(eq(hrmsAttendance.id, c.attendanceId));
  if (row) {
    const patch = mirrorPatch(sessionsOf(row), Date.now(), await approvedSpans(row.id));
    await db.update(hrmsAttendance).set({ stoppageMin: patch.stoppageMin, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hrmsAttendance.id, row.id));
  }
  await hrmsAudit(ctx, approve ? "hrms.workday.claimApprove" : "hrms.workday.claimDecline", "hrms_workday_claims", id, null, { note: note.trim() || null });
  const people = await usersOfEmployees([c.employeeId]);
  await notifyUsers(
    people.map((userId) => ({
      userId,
      title: approve ? "Counted as work" : "Kept as a break",
      body: `${hhmm(c.fromAt.getTime())}–${hhmm(c.toAt.getTime())} on ${c.date}${approve ? " now counts as work." : `: ${note.trim()}`} — ${first(ctx.employee?.name ?? ctx.user.name)}`,
      href: hrmsLink("attendance"),
      kind: approve ? "success" : "warn",
    })),
  );
  return okVoid(approve ? "Counted as work" : "Kept as a break");
}
