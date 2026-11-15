import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { hrmsHelp, hrmsWorkdayClaims } from "@/db/schema";
import { cx } from "@/components/ui/primitives";
import { has, managesFor, resolvesHelpFor, type HrmsContext } from "@/lib/hrms/access";
import { hrmsScreenModule } from "@/lib/hrms/screens";
import { allPeople, byId } from "@/lib/hrms/services/people";
import { HELP } from "@/lib/hrms/values";
import { nowHM } from "@/lib/hrms/time";
import { ReviewButtons } from "./attendance-client";

/* ---------------------------------------------------------------------------
 * TEAM TODAY, the Workday Clock design's board 13: five figures, everybody's
 * day as a table, and "To review" — the automatic breaks somebody says were
 * work, and the punch-ins asked for from outside the office or late — each
 * decided in place. The rows are the Team today list module's own, so this
 * screen and the list cannot disagree about who is working.
 * ------------------------------------------------------------------------- */

const ampm = (t: string | null | undefined) => {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}`;
};
const clock = (d: Date) => {
  const [h, m] = nowHM(d).split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
};
const initials = (n: string) =>
  n
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0]!.toUpperCase())
    .join("");
const dur = (s: string) => s.replace(/h /, ":").replace("m", "");

const NOW_CLS: Record<string, string> = {
  w: "bg-success-soft text-success",
  b: "bg-warn-soft text-warn-ink",
  i: "bg-danger-soft text-danger",
  o: "bg-canvas text-muted",
  d: "bg-canvas text-muted",
};

export async function TeamTodayView({ ctx, sp }: { ctx: HrmsContext; sp: Record<string, string | undefined> }) {
  const mod = hrmsScreenModule("teamToday")!;
  const { rows } = await mod.load(ctx, sp);
  const people = rows.map((r) => ({ ...(r.v as unknown as Record<string, string>), id: r.id })) as (Record<string, string> & { id: string })[];
  const order: Record<string, number> = { i: 0, b: 1, w: 2, o: 3, d: 4 };
  people.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.emp.localeCompare(b.emp));
  const count = (k: string) => people.filter((p) => p.kind === k).length;

  /* To review: what THIS person may decide, never their own. */
  const all = await allPeople();
  const pb = byId(all);
  const me = ctx.employee?.id ?? "";
  const claims = (await db.select().from(hrmsWorkdayClaims).where(eq(hrmsWorkdayClaims.status, "pending")).orderBy(desc(hrmsWorkdayClaims.createdAt)).limit(100)).filter(
    (c) => c.employeeId !== me && (has(ctx, "editAtt") || ctx.administrator || managesFor(ctx, c.employeeId)),
  );
  const helps = (
    await db
      .select()
      .from(hrmsHelp)
      .where(and(eq(hrmsHelp.status, "Pending"), inArray(hrmsHelp.type, [HELP.notAtOffice, HELP.runningLate])))
      .orderBy(desc(hrmsHelp.createdAt))
      .limit(100)
  ).filter((h) => h.employeeId !== me && resolvesHelpFor(ctx, h.employeeId));
  const waiting = claims.length + helps.length;

  return (
    <div className="grid gap-4">
      <div className="text-[12.5px] text-muted">Live · updated {clock(new Date())}</div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        <Figure l="Working" v={count("w")} tone="text-success" />
        <Figure l="On a break" v={count("b")} tone="text-warn-ink" />
        <Figure l="Idle now" v={count("i")} tone="text-danger" />
        <Figure l="Not punched in" v={count("o")} />
        <Figure l="Late today" v={people.filter((p) => p.late).length} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="bg-ink text-left text-[11px] font-bold tracking-[0.05em] text-white">
                <th className="px-4 py-2.5">PERSON</th>
                <th className="px-3 py-2.5">NOW</th>
                <th className="px-3 py-2.5">PUNCHED IN</th>
                <th className="px-3 py-2.5 text-right">WORKED</th>
                <th className="px-3 py-2.5 text-right">BREAKS</th>
                <th className="px-4 py-2.5 text-right">LAST ACTIVE</th>
              </tr>
            </thead>
            <tbody>
              {people.length ? (
                people.map((p) => (
                  <tr key={p.id} className="border-t border-divider">
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-2.5">
                        <span aria-hidden="true" className="flex size-8 flex-none items-center justify-center rounded-full bg-brand-soft text-[11.5px] font-bold text-brand-deep">
                          {initials(p.emp)}
                        </span>
                        <span className="leading-tight">
                          <span className="block font-semibold text-ink">{p.emp}</span>
                          <span className="block text-[12px] text-muted">{p.role || p.office}</span>
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={cx("rounded-full px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap", NOW_CLS[p.kind] ?? NOW_CLS.o)}>{p.kind === "o" ? "Not punched in" : p.now || "Not punched in"}</span>
                    </td>
                    <td className="px-3 py-2.5 font-mono">
                      {ampm(p.in)} {p.late ? <span className="ml-1 rounded bg-danger-soft px-1 text-[10px] font-bold text-danger">LATE</span> : null}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">{p.worked ? dur(p.worked) : "—"}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{p.breaks ? dur(p.breaks) : p.worked ? "0:00" : "—"}</td>
                    <td className="px-4 py-2.5 text-right text-muted">{p.last || "—"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-muted">
                    Nobody to show.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <section aria-label="To review" className="grid content-start gap-3 rounded-[12px] border border-line bg-surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-bold text-ink">To review</h2>
            <span className="text-[12.5px] text-muted">{waiting ? `${waiting} waiting` : "Nothing waiting"}</span>
          </div>
          {claims.map((c) => {
            const mins = Math.round((c.toAt.getTime() - c.fromAt.getTime()) / 60_000);
            return (
              <div key={c.id} className="grid gap-1.5 rounded-[10px] border border-line p-3">
                <div className="flex justify-between text-[13px]">
                  <span className="font-semibold text-ink">{pb.get(c.employeeId)?.name ?? "Somebody"}</span>
                  <span className="text-muted">{clock(c.createdAt)}</span>
                </div>
                <div className="text-[13px] text-body">
                  {c.kind === "auto_out" ? "Away after an automatic punch-out" : "Auto-break"}{" "}
                  <b>
                    {clock(c.fromAt).replace(/ (AM|PM)$/, "")} – {clock(c.toAt).replace(/ (AM|PM)$/, "")}
                  </b>{" "}
                  ({mins} min) · <span className="font-semibold text-brand-deep">{c.category}</span>
                </div>
                <div className="text-[13px] text-body italic">“{c.note}”</div>
                <ReviewButtons screen="workdayClaims" id={c.id} approve={{ action: "approve", label: "Count as work" }} decline={{ action: "decline", label: "Keep as break", field: "note" }} />
              </div>
            );
          })}
          {helps.map((h) => (
            <div key={h.id} className="grid gap-1.5 rounded-[10px] border border-line p-3">
              <div className="flex justify-between text-[13px]">
                <span className="font-semibold text-ink">{pb.get(h.employeeId)?.name ?? "Somebody"}</span>
                <span className="text-muted">{h.inTime ? ampm(h.inTime) : ""}</span>
              </div>
              <div className="text-[13px] text-body">{h.type === HELP.notAtOffice ? "Punch-in from outside the office" : "Running late today"}</div>
              {h.text ? <div className="text-[13px] text-body italic">“{h.text}”</div> : null}
              <ReviewButtons
                screen="help"
                id={h.id}
                approve={{ action: "approve", label: h.type === HELP.notAtOffice ? "Approve punch-in" : "Approve", values: { apply: "Yes", remark: "Approved from Team today" } }}
                decline={{ action: "decline", label: "Decline", field: "remark" }}
              />
            </div>
          ))}
          {!waiting ? <p className="text-[13px] text-muted">Automatic breaks somebody says were work, and punch-ins asked for from outside the office, wait here for you.</p> : null}
        </section>
      </div>
    </div>
  );
}

function Figure({ l, v, tone }: { l: string; v: number; tone?: string }) {
  return (
    <div className="rounded-[12px] border border-line bg-surface px-4 py-3">
      <div className="text-[12px] text-muted">{l}</div>
      <div className={cx("font-mono text-[26px] font-semibold tabular-nums", tone ?? "text-ink")}>{v}</div>
    </div>
  );
}
