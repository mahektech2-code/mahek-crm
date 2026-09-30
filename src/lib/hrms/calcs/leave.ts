import { registerCalc } from "@/lib/erp/calc";
import { daysBetweenISO, hm, tmin, weekdayOf } from "../time";

/* ---------------------------------------------------------------------------
 * The leave and overtime forms' calculators: the days a request covers, the
 * balance it would draw on, and the overtime a slot of that day's attendance
 * gives. The server decides every one of these again on save. PURE.
 * ------------------------------------------------------------------------- */

type H = Record<string, string>;
type D = Record<string, unknown>;

const who = (h: H, d: D) => h.emp || String(d.me ?? "");
const bal = (h: H, d: D, i: number) => {
  const v = (d.bal as Record<string, string> | undefined)?.[`${who(h, d)}|${(h.start || "").slice(0, 7)}`];
  return v ? `${v.split("|")[i]} days` : "";
};

registerCalc("hrms.leave.days", ({ h }) =>
  h.type === "Half Day" ? (h.start ? "0.5" : "") : h.start && h.end && h.end >= h.start ? String(daysBetweenISO(h.start, h.end) + 1) : "",
);
registerCalc("hrms.leave.paid", ({ h, data }) => bal(h, data, 0));
registerCalc("hrms.leave.unpaid", ({ h, data }) => bal(h, data, 1));
registerCalc("hrms.weekday", ({ h, l }) => {
  const d = l.date || h.date;
  return d ? weekdayOf(d) : "";
});

const ot = (h: H, d: D) => {
  const a = (d.att as Record<string, string> | undefined)?.[`${h.emp}|${h.date}`];
  if (!a) return null;
  const [i, o, oi, oo] = a.split("|");
  return h.slot === "Before Duty" ? { s: i, e: oi } : { s: oo, e: o };
};
registerCalc("hrms.ot.start", ({ h, data }) => ot(h, data)?.s ?? "");
registerCalc("hrms.ot.end", ({ h, data }) => ot(h, data)?.e ?? "");
registerCalc("hrms.ot.hours", ({ h, data }) => {
  const x = ot(h, data);
  const a = tmin(x?.s);
  const b = tmin(x?.e);
  if (a == null || b == null) return x ? "No check-out that day" : "";
  const m = b - a;
  return m > Number(data.minMinutes ?? 10) ? hm(m) : "OT not Applicable";
});
