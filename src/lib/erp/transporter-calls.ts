import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { erpTransporterCalls } from "@/db/schema";
import { APP_TIMEZONE } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { err, fieldErr, ok, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import { CLOSED, ROAD_STAGES } from "./engines/logistics";
import { callStats, isOutcome, isSource, lrChange, nextCallFor, OUTCOME_LABEL, outcomesFor, transporterKey, type CallOutcome, type CallRow, type CallSource } from "./engines/transporter-calls";
import { consignments, logCallAttempt, updateConsignment, type Consignment, type NotifyOutcome } from "./logistics";
import { erpAudit, erpId } from "./server";
import { today } from "./screens/common";

/* ---------------------------------------------------------------------------
 * CALLING A TRANSPORTER, wired to the data. One call covers every LR that
 * transporter carries for us; this writes the LR updates through the same
 * `updateConsignment` the Update dialog uses (so the events, the next call and
 * the customer's WhatsApp are exactly what they always were) and then the one
 * `erp_transporter_calls` row the history is read from.
 * ------------------------------------------------------------------------- */

/** What the person said back about one LR. Rows nobody touched are not sent. */
export type CallLrInput = { transportIds: string[]; stage?: string | null; city?: string | null; expectedOn?: string | null; pickupPoint?: string | null; notify?: boolean };

export type CallInput = {
  transporter: string;
  /** Every bill of this transporter the window showed — the call covers them all. */
  transportIds: string[];
  outcome: CallOutcome;
  source: CallSource;
  contactId?: string | null;
  spokeTo?: string | null;
  phone?: string | null;
  note?: string | null;
  nextCallOn?: string | null;
  lrs?: CallLrInput[];
};

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) || null : null);
const sumNotified = (a: NotifyOutcome, b: NotifyOutcome): NotifyOutcome => ({ sent: a.sent + b.sent, toSend: a.toSend + b.toSend, skipped: a.skipped + b.skipped, failed: a.failed + b.failed, off: a.off && b.off });

export async function logTransporterCall(ctx: ErpContext, input: CallInput): Promise<Result<{ told: number }>> {
  const name = clip(input.transporter, 120);
  if (!name) return err("Which transporter was this?", "validation");
  if (!isSource(input.source)) return fieldErr("source", "Say how the news came");
  if (!isOutcome(input.outcome) || !outcomesFor(input.source).includes(input.outcome)) return fieldErr("outcome", "Say how the call went");
  const key = transporterKey(name);
  const ids = Array.isArray(input.transportIds) ? input.transportIds.filter((x) => typeof x === "string").slice(0, 500) : [];
  /* Only this transporter's bills still on the road: a stale window cannot reach another company's LRs. */
  const bills = (await consignments({ ids })).filter((c) => transporterKey(c.transporter) === key && c.stage !== CLOSED);
  if (!bills.length) return err(`Nothing of ${name}'s is on the road any more.`, "rule_violation");
  const cfg = await getConfig();
  const next = nextCallFor(input.outcome, clip(input.nextCallOn, 10), today(), cfg["erp.logistics.callEveryDays"]);
  if (!next.ok) return fieldErr("nextCallOn", next.error);
  const note = clip(input.note, 1000);
  const spokeTo = clip(input.spokeTo, 120);
  const byId = new Map(bills.map((b) => [b.id, b]));
  const changes: { lrNo: string | null; what: string }[] = [];
  let notified: NotifyOutcome = { sent: 0, toSend: 0, skipped: 0, failed: 0, off: true };
  const failures: string[] = [];

  if (input.outcome === "update") {
    const rows = (input.lrs ?? [])
      .map((r) => ({ ...r, bills: (r.transportIds ?? []).map((id) => byId.get(id)).filter((b): b is Consignment => !!b) }))
      .filter((r) => r.bills.length);
    const moved = rows
      .map((r) => {
        const b = r.bills[0];
        const stage = r.stage && ROAD_STAGES.includes(r.stage as never) ? r.stage : b.stage;
        const what = lrChange({ lrNo: b.lrNo, stage: b.stage, expectedOn: b.expectedDeliveryOn }, { stage, city: r.city ?? "", expectedOn: r.expectedOn ?? "" });
        return what ? { r, b, stage, what } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    if (!moved.length) return fieldErr("lrs", "Nothing moved on any LR — pick “Answered — nothing new” instead");
    const movedIds = new Set<string>();
    for (const m of moved) {
      const res = await updateConsignment(ctx, m.r.bills.map((b) => b.id), {
        stage: m.stage !== m.b.stage ? m.stage : null,
        cities: clip(m.r.city, 80) ? [{ city: clip(m.r.city, 80), on: today() }] : null,
        expectedOn: clip(m.r.expectedOn, 10),
        pickupPoint: m.stage === "Ready for Pickup" ? clip(m.r.pickupPoint, 200) : undefined,
        note,
        nextCallOn: next.day,
        notify: m.r.notify !== false,
      });
      if (!res.ok) {
        failures.push(`${m.b.lrNo ?? "An LR"}: ${res.error}`);
        continue;
      }
      notified = sumNotified(notified, res.data.notified);
      changes.push({ lrNo: m.b.lrNo, what: m.what });
      for (const b of m.r.bills) movedIds.add(b.id);
    }
    const rest = bills.filter((b) => !movedIds.has(b.id)).map((b) => b.id);
    /* The LRs nothing was said about are still covered by the call: their next call is booked too. */
    if (rest.length && changes.length) await updateConsignment(ctx, rest, { nextCallOn: next.day, notify: false });
    if (!changes.length) return err(failures.join(" · "), "rule_violation");
  } else if (input.outcome === "no_change") {
    const res = await updateConsignment(ctx, bills.map((b) => b.id), { note: note ?? (input.source === "call" ? "Called — nothing new" : "Checked — nothing new"), nextCallOn: next.day, notify: false });
    if (!res.ok) return res;
  } else {
    const said = input.outcome === "no_answer" ? "Rang — no answer" : "Asked to call back";
    const res = await logCallAttempt(ctx, bills.map((b) => b.id), [said, note].filter(Boolean).join(" · "), next.day);
    if (!res.ok) return res;
  }

  const [tr] = (await db.execute(sql`select id from erp_transporters where lower(name) = ${key} limit 1`)) as unknown as { id: string }[];
  const id = erpId("etcall");
  await db.insert(erpTransporterCalls).values({
    id,
    transporter: name,
    transporterId: tr?.id ?? null,
    outcome: input.outcome,
    source: input.source,
    contactId: clip(input.contactId, 80),
    spokeTo,
    phone: clip(input.phone, 40),
    note,
    nextCallOn: next.day,
    transportIds: bills.map((b) => b.id),
    changes,
    byId: ctx.actor.id,
  });
  await erpAudit(ctx, "erp.logistics.transporterCall", "erp_transporter_call", id, null, { transporter: name, outcome: input.outcome, source: input.source, changes: changes.length });
  const told = notified.sent + notified.toSend;
  const head = input.outcome === "update" ? `${changes.length} LR${changes.length === 1 ? "" : "s"} updated` : OUTCOME_LABEL[input.outcome];
  const tail = [next.day ? `next call ${next.day}` : "calls stay due", told ? `${told} customer${told === 1 ? "" : "s"} told` : null, failures.length ? `not saved — ${failures.join(" · ")}` : null].filter(Boolean).join(" · ");
  return ok({ told }, `${head} · ${tail}`);
}

export type CallHistoryRow = CallRow & { id: string; at: string; by: string | null; spokeTo: string | null; phone: string | null; note: string | null; nextCallOn: string | null; lrCount: number };
export type CallHistory = { rows: CallHistoryRow[]; stats: ReturnType<typeof callStats> };

/** The last sixty days of calls to one transporter, newest first, and the figures over the last thirty. */
export async function transporterCallHistory(transporter: string): Promise<CallHistory> {
  const key = transporterKey(transporter);
  const rows = (await db.execute(sql`
    select c.id, c.outcome, c.source, c.at, (c.at at time zone ${APP_TIMEZONE})::date::text as day,
           c.changes, c.spoke_to as "spokeTo", c.phone, c.note, c.next_call_on::text as "nextCallOn",
           cardinality(c.transport_ids) as "lrCount", u.name as by
      from erp_transporter_calls c left join users u on u.id = c.by_id
     where lower(c.transporter) = ${key}
       and c.at > now() - interval '60 days'
     order by c.at desc, c.id desc
     limit 100
  `)) as unknown as Record<string, unknown>[];
  const out: CallHistoryRow[] = rows.map((r) => ({
    id: String(r.id),
    outcome: r.outcome as CallOutcome,
    source: r.source as CallSource,
    at: new Date(String(r.at)).toISOString(),
    day: String(r.day),
    changes: Array.isArray(r.changes) ? (r.changes as CallRow["changes"]) : [],
    by: r.by == null ? null : String(r.by),
    spokeTo: r.spokeTo == null ? null : String(r.spokeTo),
    phone: r.phone == null ? null : String(r.phone),
    note: r.note == null ? null : String(r.note),
    nextCallOn: r.nextCallOn == null ? null : String(r.nextCallOn),
    lrCount: Number(r.lrCount ?? 0),
  }));
  return { rows: out, stats: callStats(out, today()) };
}
