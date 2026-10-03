"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { hrmsAttendance, hrmsHelp, hrmsOffices } from "@/db/schema";
import { err, ok, okVoid, type Result } from "@/lib/result";
import { hrmsContext, has } from "@/lib/hrms/access";
import { hrmsAudit, hrmsId, today, now, first } from "@/lib/hrms/server";
import { attendanceCfg } from "@/lib/hrms/services/attendance";
import { timingMap } from "@/lib/hrms/services/people";
import { decideCheckIn, decideCheckOut, dayFigures, minutesBetween, type CheckInRefusal } from "@/lib/hrms/engines/attendance";
import { metresBetween, weekdayOf, hm } from "@/lib/hrms/time";
import { bindHrmsFiles } from "@/lib/hrms/attachments";
import { getConfig } from "@/lib/config/store";
import { HELP } from "@/lib/hrms/values";
import { tellPowerHolders } from "@/lib/hrms/services/notify";
import { hrmsLink } from "@/lib/hrms/registry";

/** Outside a request (a script, a test) nothing is cached, so there is nothing to invalidate — the CRM's rule. */
function refresh() {
  try {
    revalidatePath("/hrms");
  } catch {
    /* no request context */
  }
}

/* ---------------------------------------------------------------------------
 * Checking in and out from the home card (spec §6.2). The browser sends where
 * it is; the SERVER measures the distance to the office and decides — a
 * position typed into a request is still measured against the office's pin,
 * and the refusal comes from the same rule the home card explains.
 * ------------------------------------------------------------------------- */

export type CheckResult = Result<{ refusal?: CheckInRefusal; message?: string; detail?: string }>;

type Fix = { lat: number | null; lng: number | null; accuracy?: number | null };

async function officeFor(name: string | null) {
  if (!name) return null;
  const [o] = await db.select().from(hrmsOffices).where(eq(hrmsOffices.name, name)).limit(1);
  return o ?? null;
}

function refusal(reason: CheckInRefusal, message: string, detail: string): CheckResult {
  return ok({ refusal: reason, message, detail });
}

export async function hrmsCheckIn(input: Fix & { photoId?: string | null; code?: string | null }): Promise<CheckResult> {
  const ctx = await hrmsContext();
  if (!ctx.level) return err("You do not have access to HRMS. Ask an administrator to grant it.", "not_permitted");
  const me = ctx.employee;
  if (!me) return err("Your account is not linked to an employee record yet. Ask HR to link it on the Access screen.", "not_permitted");
  if (me.status !== "active") return err("Your employee record is not active, so you cannot check in. Ask HR to check it.", "not_permitted");
  const cfg = await attendanceCfg();
  const config = await getConfig();
  const t = today();
  const nowT = now();
  const [existing] = await db.select().from(hrmsAttendance).where(and(eq(hrmsAttendance.employeeId, me.id), eq(hrmsAttendance.date, t)));
  const office = await officeFor(me.office);
  const timings = await timingMap();
  const tm = timings.get(`${me.id}|${weekdayOf(t)}`);
  const privileged = has(ctx, "hr") || ctx.administrator;

  const qr = !!input.code;
  if (qr) {
    if (!config["hrms.attendance.qrEnabled"]) return err("QR check-in is switched off in HRMS settings.", "not_permitted");
    if (existing) return refusal("already", "You have already checked in today", "Check out at the end of the day.");
    if (!office || !office.qrText || office.qrText.trim() !== String(input.code).trim())
      return refusal("outside", `That is not ${office?.name ?? "your office"}’s attendance QR code`, "Scan the code printed at your own office.");
  } else {
    const hasPin = office?.lat != null && office?.lng != null;
    const distanceM = input.lat != null && input.lng != null && hasPin ? metresBetween({ lat: input.lat, lng: input.lng }, { lat: office!.lat!, lng: office!.lng! }) : input.lat == null ? null : 0;
    const d = decideCheckIn({
      alreadyToday: !!existing,
      distanceM,
      officeHasPin: hasPin,
      officeName: office?.name ?? me.office ?? "your office",
      radiusM: office?.radiusM ?? 200,
      privileged,
      privilegedRangeM: cfg.privilegedRangeM,
      officialIn: tm?.inTime ?? null,
      now: nowT,
      graceMinutes: cfg.graceMinutes,
      name: me.name,
    });
    if (!d.ok) return refusal(d.reason, d.message, d.detail);
  }

  const id = hrmsId("hatt");
  const distanceM =
    !qr && input.lat != null && input.lng != null && office?.lat != null && office?.lng != null
      ? metresBetween({ lat: input.lat, lng: input.lng }, { lat: office.lat, lng: office.lng })
      : null;
  await db.transaction(async (tx) => {
    await tx.insert(hrmsAttendance).values({
      id,
      employeeId: me.id,
      date: t,
      officeName: me.office,
      method: qr ? "qr" : "geo",
      checkIn: nowT,
      officialIn: tm?.inTime ?? null,
      officialOut: tm?.outTime ?? null,
      targetMin: tm ? minutesBetween(tm.inTime, tm.outTime) : null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      accuracyM: input.accuracy != null ? Math.round(input.accuracy) : null,
      distanceM,
      checkInCode: qr ? String(input.code) : null,
      inPhotoId: input.photoId ?? null,
      reportToStamp: me.position,
      createdById: ctx.user.id,
    });
    if (input.photoId) await bindHrmsFiles(tx, [input.photoId], "hrms_attendance", id, ctx.user.id);
  });
  await hrmsAudit(ctx, "hrms.attendance.checkIn", "hrms_attendance", id, null, { date: t, at: nowT, method: qr ? "qr" : "geo" });
  const fig = dayFigures(
    { date: t, checkIn: nowT, checkOut: null, stoppageMin: 0, officialIn: tm?.inTime ?? null, officialOut: tm?.outTime ?? null, targetMin: tm ? minutesBetween(tm.inTime, tm.outTime) : null, method: qr ? "qr" : "geo" },
    cfg,
    t,
  );
  refresh();
  return ok({}, `Checked in at ${nowT} · ${fig.lateTxt}${fig.lateBeyondGrace ? "" : fig.lateMin != null && fig.lateMin > 0 ? `, within the ${cfg.graceMinutes}-minute grace` : ""}`);
}

export async function hrmsCheckOut(input: Fix & { photoId?: string | null }): Promise<CheckResult> {
  const ctx = await hrmsContext();
  if (!ctx.level) return err("You do not have access to HRMS. Ask an administrator to grant it.", "not_permitted");
  const me = ctx.employee;
  if (!me) return err("Your account is not linked to an employee record yet. Ask HR to link it on the Access screen.", "not_permitted");
  const cfg = await attendanceCfg();
  const t = today();
  const nowT = now();
  const [row] = await db.select().from(hrmsAttendance).where(and(eq(hrmsAttendance.employeeId, me.id), eq(hrmsAttendance.date, t)));
  if (!row) return err("You have not checked in today.");
  if (row.checkOut) return err(`You already checked out at ${row.checkOut}.`);
  if (minutesBetween(row.checkIn, nowT) == null) return err(`Check-out must be after your check-in at ${row.checkIn}`);
  const office = await officeFor(me.office);
  const privileged = has(ctx, "hr") || ctx.administrator;
  const hasPin = office?.lat != null && office?.lng != null;
  const distanceM = input.lat != null && input.lng != null && hasPin ? metresBetween({ lat: input.lat, lng: input.lng }, { lat: office!.lat!, lng: office!.lng! }) : input.lat == null ? null : 0;
  if (row.method !== "qr") {
    const d = decideCheckOut({ distanceM, officeHasPin: hasPin, officeName: office?.name ?? me.office ?? "your office", radiusM: office?.radiusM ?? 200, privileged, privilegedRangeM: cfg.privilegedRangeM, name: me.name });
    if (!d.ok) return refusal(d.reason, d.message, d.detail);
  }
  await db.transaction(async (tx) => {
    await tx
      .update(hrmsAttendance)
      .set({ checkOut: nowT, outLat: input.lat ?? null, outLng: input.lng ?? null, outDistanceM: distanceM, outPhotoId: input.photoId ?? null, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(eq(hrmsAttendance.id, row.id));
    if (input.photoId) await bindHrmsFiles(tx, [input.photoId], "hrms_attendance", row.id, ctx.user.id);
  });
  await hrmsAudit(ctx, "hrms.attendance.checkOut", "hrms_attendance", row.id, null, { at: nowT });
  const fig = dayFigures({ ...row, checkOut: nowT }, cfg, t);
  refresh();
  return ok({}, `Checked out at ${nowT} · ${hm(fig.workedMin)} · ${fig.workDay}`);
}

/** "Running late today", raised from the refusal itself so nobody has to find the help screen first. */
export async function hrmsRaiseLateHelp(text: string): Promise<Result<undefined>> {
  const ctx = await hrmsContext();
  const me = ctx.employee;
  if (!ctx.level || !me) return err("Your account is not linked to an employee record yet. Ask HR to link it on the Access screen.", "not_permitted");
  /* The same door as the Help requests screen, so the same check: the button
     is drawn only for somebody holding it, and a server action is a URL. */
  if (!ctx.screens.has("help")) return err("Help requests are not on your account.", "not_permitted");
  const body = text.trim();
  if (!body) return err("Write what happened before sending.");
  const id = hrmsId("hhlp");
  await db.insert(hrmsHelp).values({ id, date: today(), employeeId: me.id, type: HELP.runningLate, inTime: now(), text: body, createdById: ctx.user.id });
  await hrmsAudit(ctx, "hrms.help.raise", "hrms_help", id, null, { type: HELP.runningLate });
  /* Raised here or on the Help screen, the people who decide it are told —
     this door used to write the request and tell nobody. */
  await tellPowerHolders(ctx.user.id, "resolve", { title: `Help request from ${me.name}`, body: `${HELP.runningLate} · ${body}`, kind: "warn", href: hrmsLink("help", { scope: "all", open: id }) });
  refresh();
  return okVoid(`Help request sent, ${first(me.name)}. The person who resolves help requests will decide and set your check-in time.`);
}
