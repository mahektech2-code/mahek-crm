import "server-only";
import { randomUUID } from "node:crypto";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, waAutomationRuns, waAutomationSettings, waTemplates, waTriggers } from "@/db/schema";
import { err, ok, okVoid, type Result } from "../result";
import { renderSpec, ruleClock, specFor, specKey, type CustomerFacts } from "../wati-templates";
import {
  insideWindow,
  istNow,
  validateRule,
  validateWindow,
  type Rule,
  type RuleStatus,
  type WindowSettings,
} from "../whatsapp-rules";
import { watiConfig } from "../wati";
import { factsFor } from "./wati-facts-service";
import { requireFounderDesk, whatsappServiceState } from "./whatsapp-switch-service";
import { sendForRule } from "./whatsapp-service";

/* ---------------------------------------------------------------------------
 * Automated WhatsApp — the founder's rules, and the pass that runs them.
 *
 * ONE MESSAGE PER CUSTOMER PER DAY, highest priority first. A customer who is
 * both 35 days overdue and past their order date gets the credit-hold
 * reminder, not both; the lower rule is simply not reached for them today.
 *
 * FOUR GATES, all of which must be open for anything to leave:
 *   the founder's service switch · the rule set to Live · the sending window
 *   (checked again before EVERY send, so a pass that runs long stops at the
 *   boundary rather than finishing its list at 1:04 pm) · the daily limit.
 * A Preview rule — or a Live one while any other gate is shut — is worked out
 * in full and written to the run log as "would send", and nothing is sent.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const SENT_STATUSES = ["queued", "sent", "sent_manually", "delivered", "read"];
/** A scheduled pass stops starting new sends after this, and the next hour carries on. */
const TIME_BUDGET_MS = 200_000;
/** Customers listed per rule in the run log. The counts cover all of them. */
const LOG_ROWS_PER_RULE = 150;

/* ---------------------------------------------------------------- reads */

export async function automationSettings(): Promise<WindowSettings> {
  const [row] = await db.select().from(waAutomationSettings).where(eq(waAutomationSettings.id, "default"));
  return row
    ? { windowStartHour: row.windowStartHour, windowEndHour: row.windowEndHour, weekdays: row.weekdays, dailyCap: row.dailyCap }
    : // Mahek's instruction, if the row was never written: 10 am to 1 pm, Mon–Sat.
      { windowStartHour: 10, windowEndHour: 13, weekdays: [1, 2, 3, 4, 5, 6], dailyCap: 300 };
}

export type RuleRow = Rule & {
  id: string;
  templateId: string;
  templateName: string;
  spec: string | null;
  watiTemplateName: string | null;
  updatedAt: Date;
  updatedByName: string | null;
  updatedById: string | null;
};

export async function listRules(): Promise<RuleRow[]> {
  const rows = await db
    .select({ rule: waTriggers, template: waTemplates })
    .from(waTriggers)
    .innerJoin(waTemplates, eq(waTemplates.id, waTriggers.templateId))
    .orderBy(asc(waTriggers.priority), asc(waTriggers.createdAt));
  return rows.map(({ rule, template }) => {
    const spec = template.watiSpec ?? specKey(template.watiTemplateName);
    return {
      id: rule.id,
      templateId: template.id,
      templateName: template.name,
      spec,
      watiTemplateName: template.watiTemplateName,
      kind: specFor(spec)?.kind ?? "payment",
      status: rule.status as RuleStatus,
      fromDay: rule.fromDay,
      toDay: rule.toDay,
      repeatEveryDays: rule.repeatEveryDays,
      maxSends: rule.maxSends,
      minAmountPaise: rule.minAmountPaise === null ? null : Number(rule.minAmountPaise),
      priority: rule.priority,
      updatedAt: rule.updatedAt,
      updatedByName: rule.updatedByName,
      updatedById: rule.updatedById,
    };
  });
}

export async function recentRuns(limit = 10) {
  return db.select().from(waAutomationRuns).orderBy(desc(waAutomationRuns.startedAt)).limit(limit);
}

/** Automated messages sent per rule in the last N days. */
export async function sendsPerRule(days = 7): Promise<Record<string, number>> {
  const rows = await db.execute<{ trigger_id: string; n: number }>(sql`
    select m.trigger_id, count(*)::int as n from wa_messages m
     where m.trigger_id is not null
       and m.status in ('sent','delivered','read')
       and m.sent_at > now() - make_interval(days => ${days}::int)
     group by m.trigger_id
  `);
  return Object.fromEntries(rows.map((r) => [r.trigger_id, Number(r.n)]));
}

/* ---------------------------------------------------------------- writes */

async function audit(ctx: Awaited<ReturnType<typeof requireFounderDesk>>, action: string, entityId: string, after: unknown) {
  await db.insert(auditLog).values({
    id: newId("aud"),
    actorId: ctx.user.id,
    actorRole: ctx.authorisedBy,
    actorApp: ctx.authorisedIn,
    action,
    entityType: "wa_trigger",
    entityId,
    afterState: after as never,
  });
}

export async function saveAutomationSettings(w: WindowSettings): Promise<Result> {
  const ctx = await requireFounderDesk();
  const problems = validateWindow(w);
  if (problems.length) return err(problems.join(" "), "validation");
  const weekdays = [...new Set(w.weekdays)].sort((a, b) => a - b);
  await db
    .insert(waAutomationSettings)
    .values({ id: "default", ...w, weekdays, updatedById: ctx.user.id, updatedByName: ctx.user.name })
    .onConflictDoUpdate({
      target: waAutomationSettings.id,
      set: { ...w, weekdays, updatedAt: new Date(), updatedById: ctx.user.id, updatedByName: ctx.user.name },
    });
  await audit(ctx, "whatsapp.automation_window", "default", { ...w, weekdays });
  return okVoid("Sending window saved");
}

export type RuleInput = {
  id?: string;
  templateId: string;
  status: RuleStatus;
  fromDay: number;
  toDay: number | null;
  repeatEveryDays: number;
  maxSends: number | null;
  minAmountPaise: number | null;
  priority: number;
};

export async function saveRule(input: RuleInput): Promise<Result<{ id: string }>> {
  const ctx = await requireFounderDesk();
  const [template] = await db.select().from(waTemplates).where(eq(waTemplates.id, input.templateId));
  if (!template) return err("That template no longer exists.", "not_found");
  const spec = specFor(template.watiSpec ?? specKey(template.watiTemplateName));
  if (!spec) return err("Only the eight WhatsApp templates can be automated.", "validation");
  if (!["off", "preview", "live"].includes(input.status)) return err("Unknown status.", "validation");

  const problems = validateRule({ ...input, kind: spec.kind });
  if (problems.length) return err(problems.join(" "), "validation");

  const values = {
    templateId: input.templateId,
    status: input.status,
    fromDay: input.fromDay,
    toDay: input.toDay,
    repeatEveryDays: input.repeatEveryDays,
    maxSends: input.maxSends,
    minAmountPaise: input.minAmountPaise,
    priority: input.priority,
    updatedAt: new Date(),
    updatedById: ctx.user.id,
    updatedByName: ctx.user.name,
  };
  const id = input.id ?? newId("trg");
  if (input.id) {
    const updated = await db.update(waTriggers).set(values).where(eq(waTriggers.id, input.id)).returning({ id: waTriggers.id });
    if (!updated.length) return err("That rule no longer exists.", "not_found");
  } else {
    await db.insert(waTriggers).values({ id, ...values });
  }
  await audit(ctx, input.id ? "whatsapp.rule_update" : "whatsapp.rule_create", id, values);
  return ok({ id }, input.id ? "Rule saved" : "Rule added");
}

export async function setRuleStatus(id: string, status: RuleStatus): Promise<Result> {
  const ctx = await requireFounderDesk();
  if (!["off", "preview", "live"].includes(status)) return err("Unknown status.", "validation");
  const updated = await db
    .update(waTriggers)
    .set({ status, updatedAt: new Date(), updatedById: ctx.user.id, updatedByName: ctx.user.name })
    .where(eq(waTriggers.id, id))
    .returning({ id: waTriggers.id });
  if (!updated.length) return err("That rule no longer exists.", "not_found");
  await audit(ctx, "whatsapp.rule_status", id, { status });
  return okVoid(status === "live" ? "Rule is live" : status === "preview" ? "Rule is in preview" : "Rule is off");
}

export async function deleteRule(id: string): Promise<Result> {
  const ctx = await requireFounderDesk();
  const deleted = await db.delete(waTriggers).where(eq(waTriggers.id, id)).returning({ id: waTriggers.id });
  if (!deleted.length) return err("That rule no longer exists.", "not_found");
  await audit(ctx, "whatsapp.rule_delete", id, null);
  return okVoid("Rule deleted");
}

/* ------------------------------------------------------------------ the pass */

export type RuleOutcome = "sent" | "would_send" | "failed" | "skipped" | "refused";

export type RuleStats = {
  ruleId: string;
  templateName: string;
  status: RuleStatus;
  /** Customers standing inside this rule's day range. */
  inRange: number;
  sent: number;
  wouldSend: number;
  failed: number;
  skipped: number;
  refused: number;
  rows: Array<{ customerId: string; customerName: string; day: number; outcome: RuleOutcome; reason: string | null }>;
};

export type RunSummary = {
  runId: string | null;
  dry: boolean;
  note: string;
  sent: number;
  wouldSend: number;
  rules: RuleStats[];
};

/**
 * One pass over every customer a rule could apply to.
 *
 * `schedule` is the hourly job: it runs only inside the window, sends for Live
 * rules if every gate is open, and logs Preview rules as "would send".
 * `preview` is the founder's button: it never sends, ignores the window, and
 * includes Off rules only when they are asked for by id.
 */
export async function runAutomation(opts: {
  source: "schedule" | "preview";
  ruleIds?: string[];
  now?: Date;
}): Promise<RunSummary> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  // The instant each send is checked against. Real time in production; a
  // test pins it, so "is it still inside the window" is not decided by
  // whatever hour the test suite happens to run at.
  const clockNow = () => (opts.now ? new Date(opts.now.getTime() + (Date.now() - started)) : new Date());
  const settings = await automationSettings();
  const day = istNow(now).date;

  if (opts.source === "schedule" && !insideWindow(settings, now)) {
    return { runId: null, dry: true, note: "Outside the sending window — nothing checked.", sent: 0, wouldSend: 0, rules: [] };
  }

  const allRules = await listRules();
  const rules = allRules.filter((r) =>
    opts.ruleIds ? opts.ruleIds.includes(r.id) : r.status !== "off",
  ).filter((r) => r.spec);
  if (!rules.length) {
    return { runId: null, dry: true, note: "No rule is on.", sent: 0, wouldSend: 0, rules: [] };
  }

  const [service, cfg] = await Promise.all([whatsappServiceState(), watiConfig()]);
  const liveGate =
    opts.source !== "schedule"
      ? "This is a preview — nothing is sent."
      : !service.active
        ? "WhatsApp sending is switched off, so Live rules were worked out but not sent."
        : !cfg
          ? "No Wati key is configured, so Live rules were worked out but not sent."
          : null;

  /* ---- who could any rule apply to ---- */
  const kinds = new Set(rules.map((r) => r.kind));
  const ids = new Set<string>();
  if (kinds.has("payment")) {
    const rows = await db.execute<{ id: string }>(sql`
      select distinct b.customer_id as id from bills b
       where b.amount > b.paid_amount and b.payment_position = 'stated'
    `);
    rows.forEach((r) => ids.add(r.id));
  }
  if (kinds.has("order")) {
    const rows = await db.execute<{ id: string }>(sql`
      select c.id from customers c
       where c.kind = 'customer' and not c.third_party and not c.cycle_is_default
         and c.last_order_date is not null and c.status <> 'deactivated' and not c.do_not_contact
    `);
    rows.forEach((r) => ids.add(r.id));
  }

  /* ---- what each rule has already sent, and who has a message today ---- */
  const history = await db.execute<{ trigger_id: string; customer_id: string; at: string }>(sql`
    select m.trigger_id, m.customer_id,
           ((coalesce(m.sent_at, m.prepared_at)) at time zone 'Asia/Kolkata')::date::text as at
      from wa_messages m
     where m.trigger_id in (${sql.join(rules.map((r) => sql`${r.id}`), sql`, `)})
       and m.status in (${sql.join(SENT_STATUSES.map((s) => sql`${s}`), sql`, `)})
  `);
  const sentBy = new Map<string, string[]>();
  for (const h of history) {
    const k = `${h.trigger_id}:${h.customer_id}`;
    sentBy.set(k, [...(sentBy.get(k) ?? []), h.at]);
  }
  const todayRows = await db.execute<{ customer_id: string }>(sql`
    select distinct m.customer_id from wa_messages m
     where m.trigger_id is not null and m.status <> 'cancelled'
       and ((m.prepared_at) at time zone 'Asia/Kolkata')::date = ${day}::date
  `);
  const messagedToday = new Set(todayRows.map((r) => r.customer_id));
  let sentToday = messagedToday.size;

  const stats = new Map<string, RuleStats>(
    rules.map((r) => [
      r.id,
      { ruleId: r.id, templateName: r.templateName, status: r.status, inRange: 0, sent: 0, wouldSend: 0, failed: 0, skipped: 0, refused: 0, rows: [] },
    ]),
  );
  const log = (r: RuleRow, f: CustomerFacts, customerId: string, clockDay: number, outcome: RuleOutcome, reason: string | null) => {
    const s = stats.get(r.id)!;
    if (outcome === "sent") s.sent++;
    else if (outcome === "would_send") s.wouldSend++;
    else if (outcome === "failed") s.failed++;
    else if (outcome === "refused") s.refused++;
    else s.skipped++;
    if (s.rows.length < LOG_ROWS_PER_RULE) {
      s.rows.push({ customerId, customerName: f.customer.name, day: clockDay, outcome, reason });
    }
  };

  let stopReason: string | null = null;

  for (const customerId of ids) {
    if (stopReason) break;
    const facts = await factsFor(customerId);
    if (!facts) continue;

    for (const rule of rules) {
      const clock = ruleClock(rule.kind, facts);
      if (!clock || clock.day < rule.fromDay || (rule.toDay !== null && clock.day > rule.toDay)) continue;
      stats.get(rule.id)!.inRange++;

      if (rule.minAmountPaise && clock.overduePaise < rule.minAmountPaise) {
        log(rule, facts, customerId, clock.day, "skipped", "Below the minimum overdue amount.");
        continue;
      }
      if (messagedToday.has(customerId)) {
        log(rule, facts, customerId, clock.day, "skipped", "Already has an automated message today.");
        break;
      }
      const past = (sentBy.get(`${rule.id}:${customerId}`) ?? []).sort();
      const last = past.at(-1);
      if (last) {
        const since = Math.round((Date.parse(day) - Date.parse(last)) / 86_400_000);
        if (since < rule.repeatEveryDays) {
          log(rule, facts, customerId, clock.day, "skipped", `Sent by this rule ${since} day${since === 1 ? "" : "s"} ago; it repeats every ${rule.repeatEveryDays}.`);
          continue;
        }
      }
      if (rule.maxSends) {
        // Counted over one pass through the rule's range, so an order rule
        // that fires "once" fires once per buying cycle, not once for ever.
        const span = Math.min((rule.toDay ?? rule.fromDay + 365) - rule.fromDay + 1, 400);
        const cutoff = Date.parse(day) - span * 86_400_000;
        const within = past.filter((d) => Date.parse(d) > cutoff).length;
        if (within >= rule.maxSends) {
          log(rule, facts, customerId, clock.day, "skipped", `Already sent ${within} time${within === 1 ? "" : "s"} — the most this rule allows.`);
          continue;
        }
      }

      const rendered = renderSpec(rule.spec!, facts);
      if (!rendered.ok) {
        log(rule, facts, customerId, clock.day, "refused", rendered.reasons[0] ?? "Refused.");
        continue;
      }

      const willSend = rule.status === "live" && !liveGate;
      if (!willSend) {
        log(rule, facts, customerId, clock.day, "would_send", rule.status === "preview" ? "Preview — not sent." : liveGate);
        messagedToday.add(customerId);
        break;
      }

      // The gates that can close DURING a pass, asked before every send.
      if (!insideWindow(settings, clockNow())) { stopReason = "The sending window closed — the rest wait for tomorrow."; break; }
      if (sentToday >= settings.dailyCap) { stopReason = `The daily limit of ${settings.dailyCap} was reached.`; break; }
      if (Date.now() - started > TIME_BUDGET_MS) { stopReason = "Time budget used — the next hourly check carries on."; break; }
      if (!rule.updatedById) {
        log(rule, facts, customerId, clock.day, "refused", "This rule has no founder on record to send on behalf of — save it once.");
        continue;
      }

      const r = await sendForRule({ customerId, templateId: rule.templateId, triggerId: rule.id, actorId: rule.updatedById, day });
      if (r.ok) {
        log(rule, facts, customerId, clock.day, "sent", null);
        sentToday++;
      } else {
        log(rule, facts, customerId, clock.day, "failed", r.error);
      }
      messagedToday.add(customerId);
      break;
    }
  }

  const list = [...stats.values()];
  const summary: RunSummary = {
    runId: newId("war"),
    dry: list.every((s) => s.sent === 0),
    note: stopReason ?? liveGate ?? "Completed.",
    sent: list.reduce((a, s) => a + s.sent, 0),
    wouldSend: list.reduce((a, s) => a + s.wouldSend, 0),
    rules: list,
  };
  await db.insert(waAutomationRuns).values({
    id: summary.runId!,
    startedAt: new Date(started),
    finishedAt: new Date(),
    dry: summary.dry,
    trigger: opts.source,
    note: summary.note,
    summary: summary as never,
  });
  return summary;
}

/** The founder's "Preview now" — never sends. */
export async function previewAutomation(ruleIds?: string[]): Promise<RunSummary> {
  await requireFounderDesk();
  return runAutomation({ source: "preview", ruleIds });
}

