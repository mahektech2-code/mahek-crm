import Link from "next/link";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { hrmsAttendance, hrmsGrievances, hrmsHelp, hrmsLeaveRequests } from "@/db/schema";
import { decidesLeave, hrmsContext, scopeOf } from "@/lib/hrms/access";
import { checkInState } from "@/lib/hrms/check-in-state";
import { approvedLeave, attendanceRows } from "@/lib/hrms/services/attendance";
import { allPeople, isActive, markableStaff, staffInReach, visibleIds } from "@/lib/hrms/services/people";
import { hrmsLink } from "@/lib/hrms/registry";
import { today } from "@/lib/hrms/server";
import { monthOf } from "@/lib/hrms/time";
import { longDate } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { HIcon } from "./_ui/icons";
import { LEAVE_WAITING } from "@/lib/hrms/values";

export const dynamic = "force-dynamic";
export const metadata = { title: "Home — HRMS — MahekOne" };

type Tone = "danger" | "warn" | "brand" | "success" | "neutral";
type WaitItem = { l: string; v: string; sub: string; tone: Tone; href: string };

const DOT: Record<Tone, string> = { danger: "bg-danger", warn: "bg-warn", brand: "bg-brand", success: "bg-success", neutral: "bg-muted" };

/**
 * HOME, by role (Nov 2026). Checking in moved to the MahekOne launcher, so
 * Home no longer carries the button: it says where today stands and links to
 * the launcher's check-in. An ASSOCIATE sees their own month; a MANAGER their
 * team today; the HR TEAM the whole company today. Under it, what is waiting
 * on this person — only items they can act on, each linking to its screen.
 */
export default async function HrmsHome() {
  const ctx = await hrmsContext();
  const t = today();
  const me = ctx.employee;
  const scope = scopeOf(ctx, "hr", "markStaff");
  const [state, people] = await Promise.all([checkInState(ctx), allPeople()]);

  /* ---------------------------------------------------------- the figures */
  type Fig = { l: string; v: string; tone?: Tone };
  let figs: Fig[] = [];
  let heading = "Your month";
  if (scope === "mine") {
    const month = monthOf(t);
    const rows = me ? await attendanceRows({ employeeIds: [me.id], from: `${month}-01`, to: t }) : [];
    const [mine] = me
      ? await db.select({ n: sql<number>`count(*)::int` }).from(hrmsLeaveRequests).where(and(eq(hrmsLeaveRequests.employeeId, me.id), eq(hrmsLeaveRequests.status, LEAVE_WAITING)))
      : [{ n: 0 }];
    const open = rows.filter((r) => !r.checkOut && r.date < t).length;
    figs = [
      { l: "Days present this month", v: String(rows.length) },
      { l: "Late this month", v: String(rows.filter((r) => (r.fig.lateMin ?? 0) > 0).length), tone: "warn" },
      { l: "Not checked out", v: String(open), tone: open ? "danger" : undefined },
      { l: "Leave waiting", v: String(mine?.n ?? 0) },
    ];
  } else {
    heading = scope === "team" ? "Your team today" : "Everybody today";
    const ids = visibleIds(ctx, scope);
    const group = people.filter((p) => isActive(p) && (!ids || ids.has(p.id)) && p.id !== (scope === "team" ? me?.id : undefined));
    const groupIds = group.map((p) => p.id);
    const [rows, leave] = await Promise.all([attendanceRows({ employeeIds: groupIds, from: t, to: t }), approvedLeave(groupIds)]);
    const present = new Set(rows.map((r) => r.employeeId));
    const onLeave = new Set(leave.filter((l) => l.startDate <= t && l.endDate >= t && !present.has(l.employeeId)).map((l) => l.employeeId));
    const missing = group.filter((p) => !present.has(p.id) && !onLeave.has(p.id)).length;
    figs = [
      { l: "In today", v: `${present.size} of ${group.length}` },
      { l: "Late", v: String(rows.filter((r) => (r.fig.lateMin ?? 0) > 0).length), tone: "warn" },
      { l: "On leave", v: String(onLeave.size) },
      { l: "Not checked in", v: String(missing), tone: missing ? "danger" : undefined },
    ];
  }

  /* ------------------------------------------------------- what is waiting */
  const wait: WaitItem[] = [];
  const count = sql<number>`count(*)::int`;
  if (me) {
    const [pend] = await db.select({ n: count }).from(hrmsAttendance).where(and(eq(hrmsAttendance.employeeId, me.id), isNull(hrmsAttendance.checkOut), lt(hrmsAttendance.date, t)));
    if (pend.n) wait.push({ l: "Your days not checked out", v: String(pend.n), sub: "That month’s salary waits until they are closed", tone: "danger", href: hrmsLink("pendingOut") });
  }
  if (ctx.screens.has("approvals") && decidesLeave(ctx)) {
    const wide = ctx.administrator || ctx.granted.has("approveLeave");
    const team = [...ctx.team].filter((id) => id !== me?.id);
    if (wide || team.length) {
      const [n] = await db
        .select({ n: count })
        .from(hrmsLeaveRequests)
        .where(and(eq(hrmsLeaveRequests.status, LEAVE_WAITING), wide ? undefined : inArray(hrmsLeaveRequests.employeeId, team)));
      if (n.n) wait.push({ l: wide ? "Leave to decide" : "Your team’s leave to decide", v: String(n.n), sub: "", tone: "warn", href: hrmsLink("approvals") });
    }
  }
  if (ctx.powers.has("checkoutStaff") && ctx.screens.has("pendingOut")) {
    /* Only the people this person may actually check out. */
    const open = await db.select({ employeeId: hrmsAttendance.employeeId }).from(hrmsAttendance).where(and(eq(hrmsAttendance.date, t), isNull(hrmsAttendance.checkOut)));
    const reach = staffInReach(ctx, people, "checkoutStaff");
    const n = open.filter((x) => x.employeeId !== me?.id && (!reach || reach.has(x.employeeId))).length;
    if (n) wait.push({ l: "Still checked in today", v: String(n), sub: "Check them out at the end of the day", tone: "neutral", href: hrmsLink("pendingOut") });
  }
  if (ctx.powers.has("markStaff") && ctx.screens.has("attendance")) {
    const todays = await attendanceRows({ from: t, to: t });
    const marked = new Set(todays.map((x) => x.employeeId));
    const n = markableStaff(ctx, people, ctx.powers.has("hr") || ctx.administrator).filter((p) => !marked.has(p.id)).length;
    if (n) wait.push({ l: "Staff not yet marked today", v: String(n), sub: "Field and other staff of your office", tone: "warn", href: hrmsLink("attendance") });
  }
  if (ctx.powers.has("resolve")) {
    const [h] = await db.select({ n: count }).from(hrmsHelp).where(eq(hrmsHelp.status, "Pending"));
    if (h.n && ctx.screens.has("help")) wait.push({ l: "Help requests waiting", v: String(h.n), sub: "", tone: "warn", href: hrmsLink("help") });
    const [g] = await db.select({ n: count }).from(hrmsGrievances).where(eq(hrmsGrievances.status, "Pending"));
    if (g.n && ctx.screens.has("grievances")) wait.push({ l: "Grievances waiting", v: String(g.n), sub: "", tone: "warn", href: hrmsLink("grievances") });
  } else if (me && ctx.screens.has("grievances")) {
    const [g] = await db.select({ n: count }).from(hrmsGrievances).where(and(eq(hrmsGrievances.status, "Pending"), eq(hrmsGrievances.toEmployeeId, me.id)));
    if (g.n) wait.push({ l: "Grievances addressed to you", v: String(g.n), sub: "", tone: "warn", href: hrmsLink("grievances") });
  }

  const d = state.today;
  const dayLine = !state.linked
    ? "Your account is not linked to an employee record yet. Ask HR to link it."
    : !d
      ? "You have not checked in today."
      : d.out
        ? `Checked in at ${d.in}, out at ${d.out} · ${d.worked} · ${d.workDay}`
        : `Checked in at ${d.in}${state.office ? ` at ${state.office}` : ""}${d.late ? ` · ${d.late}` : ""}`;

  return (
    <div className="px-6 pt-6 pb-10">
      <div className="text-[13px] text-muted">{longDate(t)}</div>
      <h1 className="mt-1 text-[20px] font-semibold text-ink">{heading}</h1>

      <CardGrid min={170} gap="gap-3" className="mt-4">
        {figs.map((f) => (
          <div key={f.l} className="rounded-[8px] border border-line bg-surface px-4 py-3">
            <div className="text-[12px] text-muted">{f.l}</div>
            <div className={cx("mt-0.5 text-[22px] font-semibold", f.tone === "danger" ? "text-danger" : f.tone === "warn" && f.v !== "0" ? "text-warn-ink" : "text-ink")}>{f.v}</div>
          </div>
        ))}
      </CardGrid>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section className="rounded-[8px] border border-line bg-surface p-5">
          <div className="text-[14px] font-semibold text-ink">Today</div>
          <div className="mt-2 flex items-start gap-3">
            <span className={cx("mt-1.5 size-2.5 flex-none rounded-full", d ? "bg-success" : "bg-warn")} />
            <div className="min-w-0 flex-1 text-[14px] text-body">{dayLine}</div>
          </div>
          {state.official ? <div className="mt-2 text-[13px] text-muted">Office hours {state.official}</div> : null}
          {state.linked && (!d || (!d.out && !d.field)) ? (
            <Link
              href="/apps?checkin=1"
              className="mt-4 inline-flex h-9 items-center rounded-[7px] bg-brand px-4 text-[13px] font-semibold text-white no-underline hover:bg-brand-hover hover:no-underline"
            >
              {d ? "Check out on the launcher" : "Check in on the launcher"}
            </Link>
          ) : null}
          <div className="mt-3 text-[12px] text-muted">Checking in and out happens on the MahekOne launcher, where you land after signing in.</div>
        </section>

        <section className="rounded-[8px] border border-line bg-surface p-5">
          <div className="text-[14px] font-semibold text-ink">Needs you</div>
          {wait.length === 0 ? <div className="mt-3 text-[13px] text-muted">Nothing is waiting for you.</div> : null}
          <div className="mt-3 grid gap-2">
            {wait.map((w) => (
              <Link
                key={w.l}
                href={w.href}
                className="flex items-center gap-3 rounded-[7px] border border-line px-3 py-2.5 no-underline hover:border-brand hover:no-underline"
              >
                <span className={cx("size-2 shrink-0 rounded-full", DOT[w.tone])} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] text-ink">{w.l}</span>
                  {w.sub ? <span className="block text-[12px] text-muted">{w.sub}</span> : null}
                </span>
                <span className="text-[14px] font-semibold text-ink">{w.v}</span>
                <HIcon n="chev" s={16} className="text-muted" />
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
