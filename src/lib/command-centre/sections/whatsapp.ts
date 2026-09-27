import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { secretStatuses } from "@/lib/secrets";
import { automationSettings, listRules, recentRuns, type RunSummary } from "@/lib/services/whatsapp-automation-service";
import { listTemplates, listUnmatchedReplies } from "@/lib/services/whatsapp-service";
import { serviceHistory, whatsappServiceState } from "@/lib/services/whatsapp-switch-service";
import { specFor, specKey } from "@/lib/wati-templates";
import { describeWindow } from "@/lib/whatsapp-rules";
import { addMonths } from "@/lib/business-date";
import { ageWords, istDay, STALE_AFTER_HOURS, watiLastEventAt } from "../freshness";
import { change, fmtDay, monthShort, num, plural, span } from "../format";
import {
  auditFor,
  emptyPage,
  notesFor,
  slice,
  stampIST,
  withPage,
  type Ctx,
  type SectionProvider,
  type TableQuery,
} from "../provider";
import type { Bar, Callout, FigureDrawer, Metric, RecordView, Result, Row, SectionPayload, TableDef, TablePage, Tone } from "../types";

/* ---------------------------------------------------------------------------
 * WHATSAPP (PRD §18) — the founder's switch, the rules, and whether anything
 * is actually going out.
 *
 * Read from the owning desk's own functions: the switch from
 * `whatsappServiceState()`, the rules from `listRules()`, templates from
 * `listTemplates()`, unmatched replies from `wa_replies` with no customer
 * (`listUnmatchedReplies`), the key from `secretStatuses()` (presence only).
 * The readiness checks are the founder WhatsApp screen's — the key, the
 * templates linked (counted the way its Automation tab counts them: every
 * active template that resolves to one of the eight specs) — plus the two
 * the Command Centre adds from records already kept: the last webhook event
 * and the hourly automation pass. The live Wati connection check is NOT run
 * here: a call to Wati per page load bills somebody for a refresh
 * (PRD §21.10); the WhatsApp desk makes that call when opened.
 *
 * Switching and making a rule Live stay on the WhatsApp desk, which confirms
 * and says what will happen; this section links there.
 * ------------------------------------------------------------------------- */

const TITLE = "WhatsApp";
const DESK = "/founder/whatsapp";

const READINESS_DEF: TableDef = {
  key: "readiness",
  title: "Setup readiness",
  hint: "Now",
  noun: "check",
  rec: "Readiness check",
  cols: [
    ["Check", "1.6fr"],
    ["State", "0.8fr"],
    ["Detail", "2fr"],
  ],
};

type Check = { id: string; label: string; state: string; tone: Tone; detail: string };

/* ---------------------------------------------------------------- reads */

const istStart = (d: string) => sql`((${d})::date)::timestamp at time zone 'Asia/Kolkata'`;
const istEnd = (d: string) => sql`((${d})::date + 1)::timestamp at time zone 'Asia/Kolkata'`;

/** Messages that left in a span of IST days: API sends WhatsApp accepted, and hand sends a person confirmed. */
async function sentIn(from: string, to: string) {
  const rows = (await db.execute(sql`
    select
      count(*) filter (where m.mode = 'automatic' and m.status in ('sent','delivered','read')
                         and m.sent_at >= ${istStart(from)} and m.sent_at < ${istEnd(to)})::int as api,
      count(*) filter (where m.mode = 'automatic' and m.status in ('delivered','read')
                         and m.sent_at >= ${istStart(from)} and m.sent_at < ${istEnd(to)})::int as delivered,
      count(*) filter (where m.status = 'sent_manually'
                         and m.confirmed_sent_at >= ${istStart(from)} and m.confirmed_sent_at < ${istEnd(to)})::int as manual
      from wa_messages m
     where coalesce(m.sent_at, m.confirmed_sent_at) >= ${istStart(from)}
       and coalesce(m.sent_at, m.confirmed_sent_at) < ${istEnd(to)}
  `)) as unknown as { api: number; delivered: number; manual: number }[];
  const r = rows[0] ?? { api: 0, delivered: 0, manual: 0 };
  return { api: Number(r.api), delivered: Number(r.delivered), manual: Number(r.manual), total: Number(r.api) + Number(r.manual) };
}

async function failedLastDay(): Promise<number> {
  const rows = (await db.execute(sql`
    select count(*)::int as n from wa_messages m
     where m.mode = 'automatic' and m.status = 'failed' and m.updated_at > now() - interval '24 hours'
  `)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

async function unmatchedCount(): Promise<number> {
  const rows = (await db.execute(sql`select count(*)::int as n from wa_replies r where r.customer_id is null`)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

async function lastAutomationPass() {
  const rows = (await db.execute(sql`
    select j.ok, j.started_at, j.finished_at, j.detail from job_runs j
     where j.job = 'whatsapp-automation' order by j.started_at desc limit 1
  `)) as unknown as { ok: boolean; started_at: string; finished_at: string | null; detail: string | null }[];
  return rows[0] ?? null;
}

/** Every active template that resolves to one of the eight specs — the Automation tab's count. */
async function automatableTemplates() {
  const templates = await listTemplates();
  return templates
    .map((t) => {
      const spec = specFor(t.watiSpec ?? specKey(t.watiTemplateName));
      return spec ? { id: t.id, name: t.name, specLabel: spec.label, watiName: t.watiTemplateName } : null;
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);
}

function listWords(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

async function readiness(): Promise<Check[]> {
  const [secrets, lastEvent, templates, pass] = await Promise.all([
    secretStatuses(),
    watiLastEventAt(),
    automatableTemplates(),
    lastAutomationPass(),
  ]);
  const key = secrets.find((s) => s.name === "wati.apiToken");
  const hasKey = Boolean(key && key.source !== "unset");

  const keyCheck: Check = {
    id: "key",
    label: "Wati key",
    state: hasKey ? "Set" : "Not set",
    tone: hasKey ? "good" : "bad",
    detail: !hasKey
      ? "No key — nothing can be sent until a platform admin sets one"
      : key!.source === "console"
        ? `Console key${key!.last4 ? ` ending ${key!.last4}` : ""}${key!.updatedAt ? ` · changed ${fmtDay(istDay(key!.updatedAt))}` : ""}`
        : "Key from the server environment",
  };

  const fresh = lastEvent && (Date.now() - new Date(lastEvent).getTime()) / 3_600_000 <= STALE_AFTER_HOURS.watiQuiet;
  const webhook: Check = {
    id: "webhook",
    label: "Webhook",
    state: !hasKey ? "Not configured" : !lastEvent ? "No events yet" : fresh ? "Receiving" : "Quiet",
    tone: !hasKey ? "muted" : !lastEvent ? "muted" : fresh ? "good" : "warn",
    detail: lastEvent
      ? `Last event ${stampIST(lastEvent)} · ${ageWords(lastEvent)} ago`
      : hasKey
        ? "Nothing has come back from Wati yet — no receipt and no reply"
        : "The webhook address is made from the key, so there is none without one",
  };

  const linked = templates.filter((t) => t.watiName);
  const unlinked = templates.filter((t) => !t.watiName);
  const tpl: Check = {
    id: "templates",
    label: "Templates linked",
    state: templates.length ? `${linked.length} of ${templates.length}` : "None",
    tone: !templates.length || !linked.length ? "bad" : unlinked.length ? "warn" : "good",
    detail: !templates.length
      ? "No active template matches one of the eight automated messages"
      : !linked.length
        ? `None of the ${templates.length} automated templates is linked to an approved Wati template`
        : unlinked.length > 3
          ? `${unlinked.length} not linked to an approved Wati template, including ${listWords(unlinked.slice(0, 2).map((t) => t.name))}`
          : unlinked.length
            ? `${listWords(unlinked.map((t) => t.name))} not linked to an approved Wati template`
        : "Every automated template is linked to an approved Wati template",
  };

  let auto: Check;
  if (!pass) auto = { id: "automation", label: "Hourly automation", state: "Never run", tone: "muted", detail: "No automation pass is recorded on this database" };
  else if (!pass.ok)
    auto = { id: "automation", label: "Hourly automation", state: "Failing", tone: "bad", detail: (pass.detail ?? "The last pass failed").split("\n")[0]! };
  else if ((Date.now() - new Date(pass.started_at).getTime()) / 3_600_000 > STALE_AFTER_HOURS.hourly)
    auto = { id: "automation", label: "Hourly automation", state: "Not running", tone: "bad", detail: `Last pass ${stampIST(pass.started_at)} · ${ageWords(pass.started_at)} ago` };
  else auto = { id: "automation", label: "Hourly automation", state: "Running", tone: "good", detail: `Last pass ${stampIST(pass.started_at)}` };

  return [keyCheck, webhook, tpl, auto];
}

function rowOf(c: Check): Row {
  return { id: c.id, cells: [{ t: c.label }, { t: c.state, pill: c.tone }, { t: c.detail }] };
}

function pageOfChecks(all: Check[], query: TableQuery): TablePage {
  const r = slice(all, query, (c, q) => [c.label, c.state, c.detail].some((x) => x.toLowerCase().includes(q)));
  return { rows: r.rows.map(rowOf), count: r.count, total: r.total, page: r.page, size: query.size, q: query.q };
}

/* ---------------------------------------------------------------- metrics */

async function readMetrics(ctx: Ctx) {
  const p = ctx.period;
  const [state, rules, settings, now, before, failed, unmatched] = await Promise.all([
    whatsappServiceState(),
    listRules(),
    automationSettings(),
    sentIn(p.from, p.to),
    sentIn(p.compareFrom, p.compareTo),
    failedLastDay(),
    unmatchedCount(),
  ]);
  const live = rules.filter((r) => r.status === "live");
  const preview = rules.filter((r) => r.status === "preview");

  const deliveredPct = now.api ? Math.round((now.delivered / now.api) * 100) : null;
  const ch = change(now.total, before.total);

  const metrics: Metric[] = [
    {
      key: "switch",
      label: "The switch",
      value: state.active ? "ON" : "OFF",
      sub: state.at
        ? `since ${fmtDay(istDay(state.at))}, by ${state.byName ?? "someone"}`
        : "never switched on — nothing has gone through the API",
      kind: "Now",
      tone: state.active ? "good" : "bad",
    },
    {
      key: "live-rules",
      label: "Live rules",
      value: num(live.length),
      sub: live.length
        ? state.active
          ? `sending ${describeWindow(settings)}`
          : "not sending while the switch is off"
        : preview.length
          ? `${num(preview.length)} in Preview · nothing sends on its own`
          : "no rule sends on its own",
      kind: "Now",
      tone: live.length && !state.active ? "warn" : undefined,
    },
    {
      key: "sent",
      label: "Sent this period",
      value: num(now.total),
      sub:
        `${ch.text} vs ${span(p.compareFrom, p.compareTo)} · ` +
        (deliveredPct == null ? "no API sends to measure delivery" : `${deliveredPct}% of API sends delivered`),
      kind: "Period",
    },
    {
      key: "failed",
      label: "Failed, last 24h",
      value: num(failed),
      sub: "automated sends",
      kind: "Now",
      tone: failed ? "warn" : undefined,
    },
    {
      key: "unmatched",
      label: "Unmatched replies",
      value: num(unmatched),
      sub: "numbers on no customer",
      kind: "Now",
    },
  ];
  return { metrics, state, live, now };
}

/* ---------------------------------------------------------------- figures */

function twelveMonths(monthKey: string): string[] {
  return Array.from({ length: 12 }, (_, i) => addMonths(monthKey, i - 11));
}

async function monthlyBars(monthKey: string, query: "sent" | "unmatched"): Promise<Bar[]> {
  const months = twelveMonths(monthKey);
  const from = `${months[0]}-01`;
  const rows = (await (query === "sent"
    ? db.execute(sql`
        select to_char(coalesce(m.sent_at, m.confirmed_sent_at) at time zone 'Asia/Kolkata', 'YYYY-MM') as month, count(*)::int as n
          from wa_messages m
         where ((m.mode = 'automatic' and m.status in ('sent','delivered','read')) or m.status = 'sent_manually')
           and coalesce(m.sent_at, m.confirmed_sent_at) >= ${istStart(from)}
         group by 1`)
    : db.execute(sql`
        select to_char(r.received_at at time zone 'Asia/Kolkata', 'YYYY-MM') as month, count(*)::int as n
          from wa_replies r
         where r.customer_id is null and r.received_at >= ${istStart(from)}
         group by 1`))) as unknown as { month: string; n: number }[];
  const by = new Map(rows.map((r) => [r.month, Number(r.n)]));
  return months.map((m, i) => ({
    h: by.get(m) ?? 0,
    tip: `${monthShort(m)} ${m.slice(0, 4)} · ${num(by.get(m) ?? 0)}`,
    ...(i === 11 ? { current: true } : {}),
  }));
}

async function dailyFailedBars(): Promise<Bar[]> {
  const days = Array.from({ length: 12 }, (_, i) => istDay(new Date(Date.now() - (11 - i) * 86_400_000)));
  const rows = (await db.execute(sql`
    select to_char(m.updated_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as day, count(*)::int as n
      from wa_messages m
     where m.mode = 'automatic' and m.status = 'failed' and m.updated_at >= now() - interval '12 days'
     group by 1`)) as unknown as { day: string; n: number }[];
  const by = new Map(rows.map((r) => [r.day, Number(r.n)]));
  return days.map((d, i) => ({ h: by.get(d) ?? 0, tip: `${fmtDay(d)} · ${num(by.get(d) ?? 0)}`, ...(i === 11 ? { current: true } : {}) }));
}

function facts(kind: string, periodLabel: string, periodValue: string, basis: string, source: string) {
  return [
    { label: "Kind", value: kind },
    { label: periodLabel, value: periodValue },
    { label: "Basis", value: basis },
    { label: "Scope", value: "Company-wide · every customer" },
    { label: "Source", value: source },
    ...(periodLabel === "As of" ? [] : [{ label: "As of", value: stampIST(new Date()) }]),
  ];
}

const signed = (n: number) => (n < 0 ? `−${Math.abs(n)}` : String(n));
const RULE_WORD: Record<string, string> = { live: "Live", preview: "Preview", off: "Off" };

/* ---------------------------------------------------------------- provider */

export const provider: SectionProvider = {
  async section(ctx: Ctx): Promise<SectionPayload> {
    const [{ metrics, state, live }, checks] = await Promise.all([readMetrics(ctx), readiness()]);
    const callouts: Callout[] = [];
    if (live.length && !state.active) {
      callouts.push({
        tone: "bad",
        text: `${live.length === 1 ? "One rule is" : `${num(live.length)} rules are`} Live but the switch is OFF, so nothing automated is going out. Switch on, or set the ${live.length === 1 ? "rule" : "rules"} to Preview.`,
        act: "Review the switch",
        href: DESK,
      });
    }
    return {
      metrics,
      callouts,
      tables: [withPage(READINESS_DEF, pageOfChecks(checks, { q: "", page: 1, size: 25 }))],
      foot: "Switching WhatsApp on or off, and making a rule Live, both confirm first and say what will happen.",
    };
  },

  async tablePage(_ctx: Ctx, table: string, query: TableQuery): Promise<TablePage> {
    if (table !== "readiness") return emptyPage(query);
    return pageOfChecks(await readiness(), query);
  },

  async figure(ctx: Ctx, metric: string): Promise<FigureDrawer> {
    const { metrics } = await readMetrics(ctx);
    const m = metrics.find((x) => x.key === metric);
    if (!m) throw new Error("There is no such figure here.");
    const p = ctx.period;
    const asOf = stampIST(new Date());
    const base = { title: m.label, value: m.value };

    if (metric === "switch") {
      const history = await serviceHistory(8);
      return {
        ...base,
        kind: "Now figure · Messaging",
        facts: facts("Now", "As of", asOf, "The newest decision on the switch", "WhatsApp switch history"),
        def: "Whether messages go to customers through the WhatsApp API at all. The newest decision wins, and no decision ever means off. Off, every screen copies and pastes exactly as before.",
        bars: [],
        barsLabel: "No history is kept for this figure",
        rowsLabel: "Who switched it, and when",
        rows: history.map((h) => ({ a: h.active ? "Switched on" : "Switched off", b: `${h.changedByName}${h.note ? ` · “${h.note}”` : ""}`, c: stampIST(h.at) })),
        noRowsLine: history.length ? undefined : "Never switched. It has been off since the start.",
      };
    }

    if (metric === "live-rules") {
      const rules = await listRules();
      return {
        ...base,
        kind: "Now figure · Messaging",
        facts: facts("Now", "As of", asOf, "Rules set to Live", "WhatsApp automation rules"),
        def: "Automation rules set to Live. A Live rule sends only while the switch is on, inside the sending window and under the daily limit; otherwise it is worked out and logged as would-send. A rule in Preview never sends.",
        bars: [],
        barsLabel: "No history is kept for this figure",
        rowsLabel: "Every rule",
        rows: rules.slice(0, 8).map((r) => ({
          a: r.templateName,
          b: `Days ${signed(r.fromDay)}${r.toDay == null ? " onwards" : ` to ${signed(r.toDay)}`} · every ${plural(r.repeatEveryDays, "day")}${r.watiTemplateName ? "" : " · template not linked"}`,
          c: RULE_WORD[r.status] ?? r.status,
        })),
        noRowsLine: rules.length ? undefined : "No automation rule has been set up.",
      };
    }

    if (metric === "sent") {
      const [bars, recent] = await Promise.all([
        monthlyBars(p.monthKey, "sent"),
        db.execute(sql`
          select c.name as customer, coalesce(m.template_name, 'Free text') as template, m.mode, m.status,
                 coalesce(m.sent_at, m.confirmed_sent_at) as at
            from wa_messages m join customers c on c.id = m.customer_id
           where ((m.mode = 'automatic' and m.status in ('sent','delivered','read')) or m.status = 'sent_manually')
             and coalesce(m.sent_at, m.confirmed_sent_at) >= ${istStart(p.from)}
             and coalesce(m.sent_at, m.confirmed_sent_at) < ${istEnd(p.to)}
           order by coalesce(m.sent_at, m.confirmed_sent_at) desc limit 8`),
      ]);
      const STATUS: Record<string, string> = { sent: "Sent", delivered: "Delivered", read: "Read", sent_manually: "Sent by hand" };
      const rows = (recent as unknown as { customer: string; template: string; mode: string; status: string; at: string }[]).map((r) => ({
        a: r.customer,
        b: `${r.template} · ${r.mode === "automatic" ? "through the API" : "copied and pasted"} · ${stampIST(r.at)}`,
        c: STATUS[r.status] ?? r.status,
      }));
      return {
        ...base,
        kind: "Period figure · Messaging",
        facts: facts("Period", "Period", span(p.from, p.to), "Messages that left in the period, by IST date sent", "WhatsApp message log"),
        def: "Messages that left for a customer in the period: API sends WhatsApp accepted (sent, delivered or read), plus messages a person copied, pasted and confirmed as sent. The delivered share is of API sends only — a hand-sent message has no receipt.",
        bars,
        barsLabel: "Messages sent each month, last 12 months",
        rowsLabel: "Latest sends in the period",
        rows,
        noRowsLine: rows.length ? undefined : "Nothing was sent in this period.",
      };
    }

    if (metric === "failed") {
      const [bars, recent] = await Promise.all([
        dailyFailedBars(),
        db.execute(sql`
          select c.name as customer, coalesce(m.template_name, 'Free text') as template, m.failure_reason as reason, m.updated_at as at
            from wa_messages m join customers c on c.id = m.customer_id
           where m.mode = 'automatic' and m.status = 'failed' and m.updated_at > now() - interval '24 hours'
           order by m.updated_at desc limit 8`),
      ]);
      const rows = (recent as unknown as { customer: string; template: string; reason: string | null; at: string }[]).map((r) => ({
        a: r.customer,
        b: `${r.template} · ${r.reason ?? "no reason reported"}`,
        c: stampIST(r.at),
      }));
      return {
        ...base,
        kind: "Now figure · Messaging",
        facts: facts("Now", "As of", asOf, "Automated sends marked failed in the last 24 hours", "WhatsApp message log"),
        def: "Messages sent through the API that WhatsApp or Wati reported as failed in the last 24 hours. A hand-copied message cannot fail here — it has no receipt.",
        bars,
        barsLabel: "Failed automated sends per day, last 12 days",
        rowsLabel: "Failed in the last 24 hours",
        rows,
        noRowsLine: rows.length ? undefined : "No automated send failed in the last 24 hours.",
      };
    }

    // unmatched
    const [bars, replies] = await Promise.all([monthlyBars(p.monthKey, "unmatched"), listUnmatchedReplies(8)]);
    return {
      ...base,
      kind: "Now figure · Messaging",
      facts: facts("Now", "As of", asOf, "Every reply from a number on no customer", "WhatsApp replies"),
      def: "Replies from numbers that match no customer's phone or WhatsApp number. They are kept rather than dropped; putting the number on the right customer files future replies automatically.",
      bars,
      barsLabel: "Unmatched replies received each month, last 12 months",
      rowsLabel: "Latest unmatched replies",
      rows: replies.map((r) => ({
        a: r.senderName ? `${r.senderName}${r.waId ? ` · +${r.waId}` : ""}` : r.waId ? `+${r.waId}` : "Unknown number",
        b: r.message.length > 90 ? r.message.slice(0, 89) + "…" : r.message,
        c: stampIST(r.receivedAt),
      })),
      noRowsLine: replies.length ? undefined : "Every reply so far came from a number on a customer.",
    };
  },

  async record(_ctx: Ctx, table: string, id: string): Promise<RecordView> {
    if (table !== "readiness") throw new Error("There is no such record here.");
    const checks = await readiness();
    const c = checks.find((x) => x.id === id);
    if (!c) throw new Error("That check is no longer listed.");
    const notes = await notesFor("whatsapp_readiness", id);

    const fields: { label: string; value: string }[] = [
      { label: "State", value: c.state },
      { label: "Detail", value: c.detail },
    ];
    let timeline: { what: string; when: string }[] = [];
    let audit: { what: string; who: string }[] = [];
    let href = { label: "WhatsApp desk", url: DESK };

    if (id === "key") {
      const key = (await secretStatuses()).find((s) => s.name === "wati.apiToken");
      fields.push(
        { label: "Held in", value: !key || key.source === "unset" ? "Nowhere — not set" : key.source === "console" ? "The Admin Console" : "The server environment" },
        { label: "Ends in", value: key?.last4 ?? "—" },
        { label: "Last changed", value: key?.updatedAt ? stampIST(key.updatedAt) : "—" },
        { label: "Who can change it", value: "A platform admin, in the Admin Console" },
      );
      audit = await auditFor("app_secret", "wati.apiToken");
    } else if (id === "webhook") {
      const events = (await db.execute(sql`
        (select 'Reply from ' || coalesce(r.sender_name, '+' || r.wa_id, 'an unknown number') ||
                case when r.customer_id is null then ' (no customer)' else '' end as what, r.received_at as at
           from wa_replies r order by r.received_at desc limit 10)
        union all
        (select 'Read receipt · ' || coalesce(m.template_name, 'message'), m.read_at from wa_messages m
          where m.read_at is not null order by m.read_at desc limit 10)
        union all
        (select 'Delivered receipt · ' || coalesce(m.template_name, 'message'), m.delivered_at from wa_messages m
          where m.delivered_at is not null order by m.delivered_at desc limit 10)
        union all
        (select 'Failure reported · ' || coalesce(m.failure_reason, 'no reason'), m.updated_at from wa_messages m
          where m.status = 'failed' and m.mode = 'automatic' order by m.updated_at desc limit 10)
        order by at desc limit 15`)) as unknown as { what: string; at: string }[];
      timeline = events.map((e) => ({ what: e.what, when: stampIST(e.at) }));
      fields.push({ label: "What it receives", value: "Delivered, read and failed receipts for API sends, and customers' replies" });
    } else if (id === "templates") {
      const templates = await automatableTemplates();
      for (const t of templates) {
        fields.push({ label: t.name, value: t.watiName ? `Sent as the Wati template “${t.watiName}” · ${t.specLabel}` : `Not linked · ${t.specLabel}` });
      }
      const per = await Promise.all(templates.map((t) => auditFor("wa_template", t.id, 5)));
      audit = per.flat().slice(0, 20);
    } else if (id === "automation") {
      const [settings, rules, runs] = await Promise.all([automationSettings(), listRules(), recentRuns(12)]);
      fields.push(
        { label: "Sending window", value: describeWindow(settings) },
        { label: "Daily limit", value: plural(settings.dailyCap, "message") },
        {
          label: "Rules",
          value: rules.length
            ? `${num(rules.filter((r) => r.status === "live").length)} Live · ${num(rules.filter((r) => r.status === "preview").length)} in Preview · ${num(rules.filter((r) => r.status === "off").length)} off`
            : "None set up",
        },
      );
      timeline = runs.map((r) => {
        const s = r.summary as RunSummary;
        const what = r.trigger === "preview" ? "Preview" : "Scheduled pass";
        return {
          what: `${what} · ${num(s?.sent ?? 0)} sent, ${num(s?.wouldSend ?? 0)} would send${r.note ? ` — ${r.note}` : ""}`,
          when: stampIST(r.startedAt),
        };
      });
      const per = await Promise.all(rules.map((r) => auditFor("wa_trigger", r.id, 5)));
      audit = per.flat().slice(0, 20);
      href = { label: "WhatsApp automation", url: `${DESK}/automation` };
    }

    return {
      kind: `${READINESS_DEF.rec} · ${TITLE}`,
      title: c.label,
      sub: `${c.state} · ${c.detail}`,
      fields,
      timeline: [...notes, ...timeline],
      audit,
      acts: [],
      href,
      noteTarget: { kind: "whatsapp_readiness", id },
    };
  },

  async act(): Promise<Result> {
    return {
      ok: false,
      error: "Nothing is changed from this list. Switching WhatsApp and making a rule Live are done on the WhatsApp desk, which confirms first.",
    };
  },
};
