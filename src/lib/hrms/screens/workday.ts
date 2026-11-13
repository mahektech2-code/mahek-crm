import "server-only";
import { and, desc, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { hrmsWorkdayClaims } from "@/db/schema";
import type { ActionSpec } from "@/lib/erp/ui";
import { scopeFor } from "./attendance";
import { has, managesFor, type HrmsContext } from "../access";
import { today, type HrmsScreenModule } from "../server";
import { allPeople, byId, isActive, visibleIds } from "../services/people";
import { attendanceRows } from "../services/attendance";
import { approvedSpans, sessionsOf, settledToday, workdayCfg } from "../services/workday";
import { breaksOf, phaseOf, workedMs } from "../engines/workday";
import { addDaysISO, fdShort, hm, nowHM } from "../time";
import { decideClaim } from "../workday-ops";

/* ---------------------------------------------------------------------------
 * The workday clock's two HRMS tabs, under Attendance: TEAM TODAY, who is
 * working, on a break or not in right now; and CORRECTIONS, the "I was
 * working away from the screen" claims, decided by the person's manager.
 * ------------------------------------------------------------------------- */

const hhmm = (ms: number | null | undefined) => (ms ? nowHM(new Date(ms)) : "");

const NOW_WORDS: Record<string, string> = {
  none: "Not in",
  working: "Working",
  break: "On a break",
  auto_break: "Auto-break",
  auto_out: "Punched out · auto",
  done: "Punched out",
};

const teamToday: HrmsScreenModule = {
  key: "teamToday",
  async load(ctx, q) {
    const t = today();
    const now = Date.now();
    const { scope, options } = scopeFor(ctx, q, "hr", "editAtt");
    const [people, cfg] = await Promise.all([allPeople(), workdayCfg()]);
    const ids = visibleIds(ctx, scope);
    const shown = people.filter((p) => isActive(p) && (!ids || ids.has(p.id)));
    /* Settle each open day first, so "working" is never a person who left an hour ago. */
    const rows = await attendanceRows({ employeeIds: shown.map((p) => p.id), from: t, to: t });
    const settled = new Map<string, Awaited<ReturnType<typeof settledToday>>>();
    for (const r of rows) if (!r.id.startsWith("mbos:")) settled.set(r.employeeId, await settledToday(r.employeeId, now));
    const out = [];
    for (const p of shown) {
      const field = rows.find((r) => r.employeeId === p.id && r.id.startsWith("mbos:"));
      const row = settled.get(p.id) ?? null;
      const s = row ? sessionsOf(row) : [];
      const phase = field ? "field" : phaseOf(s);
      const worked = row ? workedMs(s, now, await approvedSpans(row.id)) : 0;
      const breaks = breaksOf(s, now).reduce((n, b) => n + ((b.to ?? now) - b.from), 0);
      const last = row?.lastActivityAt?.getTime() ?? null;
      const idleMin = phase === "working" && last ? Math.floor((now - last) / 60_000) : 0;
      const nowWord = field ? "On the field app" : phase === "working" && idleMin >= cfg.warnMinutes ? `Idle ${idleMin} min` : NOW_WORDS[phase] ?? "";
      out.push({
        id: p.id,
        v: {
          emp: p.name,
          office: p.office ?? "",
          now: nowWord,
          in: row?.checkIn ?? field?.checkIn ?? "",
          worked: row ? hm(Math.floor(worked / 60_000)) : "",
          breaks: row && breaks ? hm(Math.floor(breaks / 60_000)) : "",
          last: phase === "working" ? (idleMin ? `${idleMin} min ago` : "now") : last ? hhmm(last) : "",
        },
        flags: [] as string[],
        title: p.name,
        header: `${p.position ?? ""} · ${p.office ?? ""}`,
        fields: s.length
          ? [
              { l: "Stretches", v: s.map((x) => `${hhmm(x.in)}–${x.out ? hhmm(x.out) : "now"}${x.end === "break" ? ` (break${x.reason ? `: ${x.reason}` : ""})` : x.end === "idle" ? " (no activity)" : x.end === "auto_out" ? " (closed automatically)" : ""}`).join(" · ") },
            ]
          : [],
        actions: [{ id: "open", l: "Open their days", href: `/hrms/attendance?scope=${scope}&emp=${p.id}&from=${addDaysISO(t, -30)}` }] as ActionSpec[],
      });
    }
    return {
      spec: {
        screen: "teamToday",
        cols: [
          { k: "emp", l: "Person", t: "b" },
          { k: "now", l: "Now", t: "s" },
          { k: "in", l: "Punched in", t: "t" },
          { k: "worked", l: "Worked", t: "t" },
          { k: "breaks", l: "Breaks", t: "t" },
          { k: "last", l: "Last active", t: "t" },
          { k: "office", l: "Office", t: "t" },
        ],
        hidden: [],
        sortDefault: ["now", 1],
        godownKey: "office",
        readOnly: true,
        noDataLine: "Nobody to show.",
        hrms: { scope: { current: scope, options } },
      },
      rows: out,
    };
  },
};

function claimActions(ctx: HrmsContext, c: typeof hrmsWorkdayClaims.$inferSelect): ActionSpec[] {
  if (c.status !== "pending") return [];
  const may = (has(ctx, "editAtt") || ctx.administrator || managesFor(ctx, c.employeeId)) && ctx.employee?.id !== c.employeeId;
  const why = may ? undefined : ctx.employee?.id === c.employeeId ? "Somebody else decides your own claims" : "Only their manager or HR can decide this";
  return [
    { id: "approve", l: "Count as work", primary: true, why },
    {
      id: "decline",
      l: "Keep as a break",
      why,
      prompt: { title: "Keep as a break", sub: "They are told why.", submit: "Keep as a break", fields: [{ k: "note", l: "Why", t: "area", req: true }] },
    },
  ];
}

const workdayClaims: HrmsScreenModule = {
  key: "workdayClaims",
  async load(ctx, q) {
    const { scope, options } = scopeFor(ctx, q, "hr", "editAtt");
    const people = await allPeople();
    const ids = visibleIds(ctx, scope);
    const conds = [gte(hrmsWorkdayClaims.date, addDaysISO(today(), -60))];
    if (ids) conds.push(inArray(hrmsWorkdayClaims.employeeId, ids.size ? [...ids] : ["-"]));
    const rows = await db.select().from(hrmsWorkdayClaims).where(and(...conds)).orderBy(desc(hrmsWorkdayClaims.createdAt));
    const pb = byId(people);
    return {
      spec: {
        screen: "workdayClaims",
        cols: [
          { k: "date", l: "Date", t: "d" },
          { k: "emp", l: "Person", t: "b" },
          { k: "span", l: "Time", t: "t" },
          { k: "kind", l: "Recorded as", t: "t" },
          { k: "category", l: "Doing", t: "t" },
          { k: "note", l: "In their words", t: "t" },
          { k: "status", l: "Status", t: "s" },
        ],
        hidden: [],
        sortDefault: ["date", -1],
        noDataLine: "No corrections asked for. When an automatic break was really work, the person asks here and their manager decides.",
        hrms: { scope: { current: scope, options } },
      },
      rows: rows.map((c) => ({
        id: c.id,
        v: {
          date: c.date,
          emp: pb.get(c.employeeId)?.name ?? "",
          span: `${hhmm(c.fromAt.getTime())}–${hhmm(c.toAt.getTime())} · ${hm(Math.round((c.toAt.getTime() - c.fromAt.getTime()) / 60_000))}`,
          kind: c.kind === "auto_out" ? "Away after an automatic punch-out" : "Automatic break",
          category: c.category,
          note: c.note,
          status: c.status === "pending" ? "Pending" : c.status === "approved" ? "Approved" : "Rejected",
        },
        flags: [],
        title: `${pb.get(c.employeeId)?.name ?? ""} · ${fdShort(c.date)}`,
        fields: c.decidedNote ? [{ l: "Decision", v: c.decidedNote }] : [],
        actions: claimActions(ctx, c),
      })),
    };
  },
  actions: {
    approve: (ctx, id) => decideClaim(ctx, id, true, ""),
    decline: (ctx, id, values) => decideClaim(ctx, id, false, values.note ?? ""),
  },
};

export const WORKDAY_SCREENS: HrmsScreenModule[] = [teamToday, workdayClaims];
