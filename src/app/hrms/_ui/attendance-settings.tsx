import Link from "next/link";
import { db } from "@/db";
import { hrmsStaffTimings } from "@/db/schema";
import { cx } from "@/components/ui/primitives";
import { getConfig } from "@/lib/config/store";
import type { HrmsContext } from "@/lib/hrms/access";
import { allPeople, isActive, officeWeek, offices } from "@/lib/hrms/services/people";
import { hrmsLink } from "@/lib/hrms/registry";
import { AttendanceSettingsEditor, OfficeWeekEditor } from "./attendance-client";
import { Note } from "./my-attendance";

/* ---------------------------------------------------------------------------
 * The Workday Clock design's boards 14 and 15 under HRMS → Settings:
 * ATTENDANCE SETTINGS (the lock, idleness, break reasons, present and half
 * day) and OFFICE TIMINGS (each office's week, the late grace, and who has
 * timings of their own).
 * ------------------------------------------------------------------------- */

export async function AttendanceRulesView({ ctx }: { ctx: HrmsContext }) {
  const c = await getConfig();
  return (
    <AttendanceSettingsEditor
      canEdit={ctx.administrator}
      timingsHref={hrmsLink("officeTimings")}
      initial={{
        lockEnabled: c["hrms.workday.lockEnabled"],
        exemptPlatformAdmins: c["hrms.workday.exemptPlatformAdmins"],
        warn: c["hrms.workday.idleWarnMinutes"],
        brk: c["hrms.workday.idleBreakMinutes"],
        out: c["hrms.workday.idleOutMinutes"],
        breakOut: c["hrms.workday.breakOutMinutes"],
        reasons: c["hrms.workday.breakReasons"].split(",").map((x) => x.trim()).filter(Boolean),
        present: c["hrms.attendance.presentHours"],
        half: c["hrms.attendance.halfDayHours"],
      }}
    />
  );
}

const ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SHORT: Record<string, string> = { Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu", Friday: "Fri", Saturday: "Sat", Sunday: "Sun" };
const ampm = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
};
const hmm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

/** "Mon – Sat" for a run of days, else the days listed. */
function daysText(days: string[]): string {
  const idx = days.map((d) => ORDER.indexOf(d)).sort((a, b) => a - b);
  const run = idx.every((x, i) => i === 0 || x === idx[i - 1] + 1);
  return run && idx.length > 2 ? `${SHORT[ORDER[idx[0]]]} – ${SHORT[ORDER[idx[idx.length - 1]]]}` : idx.map((i) => SHORT[ORDER[i]]).join(", ");
}

export async function OfficeTimingsView({ ctx, sp }: { ctx: HrmsContext; sp: Record<string, string | undefined> }) {
  const [offs, people, own, c] = await Promise.all([offices(), allPeople(), db.select().from(hrmsStaffTimings), getConfig()]);
  const live = offs.filter((o) => o.active);
  if (!live.length) return <Note>There are no offices yet. Add one under People → Offices, then give it a week here.</Note>;
  const current = live.find((o) => o.id === sp.office) ?? live[0];
  const week = await officeWeek(current.id);
  const staff = people.filter((p) => isActive(p));
  const headcount = (name: string) => staff.filter((p) => p.office === name).length;
  const canEdit = ctx.administrator || ctx.powers.has("timings");
  const base = hrmsLink("officeTimings");
  const href = (id: string) => `${base}${base.includes("?") ? "&" : "?"}office=${encodeURIComponent(id)}`;

  /* People at this office with timings of their own, which replace its week. */
  const byPerson = new Map<string, typeof own>();
  for (const r of own) byPerson.set(r.employeeId, [...(byPerson.get(r.employeeId) ?? []), r]);
  const exceptions = staff
    .filter((p) => p.office === current.name && byPerson.has(p.id))
    .map((p) => {
      const rows = byPerson.get(p.id)!;
      const f = rows[0];
      const same = rows.every((r) => r.inTime === f.inTime && r.outTime === f.outTime);
      return {
        id: p.id,
        name: p.name,
        role: p.position ?? "",
        when: same ? `${daysText(rows.map((r) => r.weekday))} · ${ampm(f.inTime)} – ${ampm(f.outTime)}` : `${daysText(rows.map((r) => r.weekday))} · hours vary by day`,
        present: hmm(f.presentMin ?? Math.round(c["hrms.attendance.presentHours"] * 60)),
      };
    });

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href={hrmsLink("attendanceRules")} className="text-[13px] font-semibold text-brand hover:underline">
            ← Attendance settings
          </Link>
          <h2 className="mt-1 text-[20px] font-bold text-ink">Office timings</h2>
        </div>
      </div>
      <div role="tablist" aria-label="Office" className="flex flex-wrap gap-2">
        {live.map((o) => (
          <Link
            key={o.id}
            role="tab"
            aria-selected={o.id === current.id}
            href={href(o.id)}
            className={cx(
              "inline-flex h-9 items-center gap-2 rounded-full border px-4 text-[13px] font-semibold",
              o.id === current.id ? "border-brand bg-brand-soft text-brand-deep" : "border-line bg-surface text-ink hover:bg-canvas",
            )}
          >
            {o.name}
            <span className="text-[12px] font-normal text-muted">
              {headcount(o.name)}
              {o.id === current.id ? " people" : ""}
            </span>
          </Link>
        ))}
      </div>

      <OfficeWeekEditor
        key={current.id}
        officeId={current.id}
        officeName={current.name}
        canEdit={canEdit}
        hours={{ open: current.openingTime || "09:30", close: current.closingTime || "18:30" }}
        defaults={{ present: c["hrms.attendance.presentHours"], half: c["hrms.attendance.halfDayHours"] }}
        initial={week.map((r) => ({ weekday: r.weekday, working: true, inTime: r.inTime, outTime: r.outTime, presentMin: r.presentMin, halfMin: r.halfMin }))}
      />
      {!week.length ? (
        <p className="text-[12.5px] text-muted">
          No week set for {current.name} yet. Until one is saved, people here without timings of their own have no office hours, so every day counts and none is a week off.
        </p>
      ) : null}


      <section aria-labelledby="pp-t" className="rounded-[14px] border border-line bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 pb-3">
          <div>
            <h3 id="pp-t" className="text-[15px] font-bold text-ink">
              People with their own timings
            </h3>
            <div className="text-[12.5px] text-muted">These replace the office&apos;s week for that person.</div>
          </div>
          {canEdit ? (
            <Link href={`${hrmsLink("timings")}${hrmsLink("timings").includes("?") ? "&" : "?"}new=1`} className="flex h-9 items-center rounded-[9px] border border-line-strong bg-surface px-3.5 text-[13px] font-semibold text-ink hover:bg-canvas">
              + Add a person
            </Link>
          ) : null}
        </div>
        {exceptions.length ? (
          exceptions.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-4 border-t border-divider px-5 py-3 text-[13px]">
              <span className="flex min-w-[200px] flex-1 items-center gap-2.5">
                <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-brand-soft text-[11.5px] font-bold text-brand-deep">
                  {p.name
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((x) => x[0])
                    .join("")
                    .toUpperCase()}
                </span>
                <span className="leading-tight">
                  <span className="block font-semibold text-ink">{p.name}</span>
                  <span className="block text-[12px] text-muted">{p.role}</span>
                </span>
              </span>
              <span className="text-body">{p.when}</span>
              <span className="text-muted">present at {p.present}</span>
              <Link href={`${hrmsLink("timings")}${hrmsLink("timings").includes("?") ? "&" : "?"}q=${encodeURIComponent(p.name)}`} className="font-semibold text-brand hover:underline">
                Edit
              </Link>
            </div>
          ))
        ) : (
          <p className="border-t border-divider px-5 py-4 text-[13px] text-muted">Everybody at {current.name} works the office&apos;s week.</p>
        )}
      </section>

      <p className="text-[12.5px] text-muted">Changes apply from tomorrow. Days already worked keep the timings they were worked under.</p>
    </div>
  );
}
