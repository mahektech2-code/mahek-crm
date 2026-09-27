import "server-only";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { erpAlerts } from "@/db/schema";
import { calendarDate } from "@/lib/business-date";
import { err, fieldErr, okVoid } from "@/lib/result";
import { runErpAlerts, visibleAlerts } from "../alerts";
import { ALERT_LABEL, type AlertKind } from "../engines/alerts";
import { erpHref, erpScreen } from "../registry";
import { erpAudit, text, type ScreenModule } from "../server";
import type { ColSpec, ListRow } from "../ui";
import type { ErpContext } from "../access";

/* ---------------------------------------------------------------------------
 * AI-4's screen: every alert a person may see — they hold the screen it points
 * at, and its power where it shows money or cost — with the records behind it
 * one click away. Open → Acknowledged (with a note) → Resolved (with a reason,
 * or automatically once the condition clears).
 * ------------------------------------------------------------------------- */

const canRun = (ctx: ErpContext) => ctx.administrator || ctx.level === "manager";

export const alertsScreen: ScreenModule = {
  key: "alerts",
  async load(ctx) {
    const rows = await visibleAlerts(ctx.screens, ctx.powers);
    const cols: ColSpec[] = [
      { k: "raised", l: "Raised", t: "d" },
      { k: "status", l: "Status", t: "s" },
      { k: "kind", l: "Alert", t: "b" },
      { k: "explanation", l: "What is unusual", t: "t", w: 420 },
      { k: "note", l: "Note", t: "t" },
    ];
    return {
      spec: {
        screen: "alerts",
        cols,
        hidden: [],
        groups: ["status"],
        chips: "kind",
        newForm: canRun(ctx) ? { screen: "alerts", id: "run", title: "Run the checks now", sub: "The checks also run every hour. Anything that has cleared is resolved; anything new is raised once.", submit: "Run checks", header: [] } : undefined,
        newLabel: "Run checks now",
        noDataLine: "Nothing unusual. Alerts appear here when a check finds something, and clear on their own when it is put right.",
      },
      rows: rows.map((a): ListRow => {
        const screen = erpScreen(a.screen);
        const open = a.status !== "Resolved";
        return {
          id: a.id,
          v: { raised: calendarDate(a.raisedAt), status: a.status, kind: ALERT_LABEL[a.kind as AlertKind] ?? a.kind, explanation: a.explanation, note: a.note ?? a.resolveReason },
          flags: open ? ["alert"] : [],
          title: ALERT_LABEL[a.kind as AlertKind] ?? a.kind,
          header: a.explanation,
          actions: [
            ...(screen ? [{ id: "open", l: "Open the records", primary: true, href: `${erpHref(screen)}?f=${encodeURIComponent(a.recordIds.join(","))}&fl=${encodeURIComponent(ALERT_LABEL[a.kind as AlertKind] ?? "Alert")}` }] : []),
            ...(a.status === "Open"
              ? [{ id: "ack", l: "Acknowledge", prompt: { title: "Acknowledge", sub: a.explanation, submit: "Acknowledge", fields: [{ k: "note", l: "Note", t: "area" as const, req: true, mic: true }] } }]
              : []),
            ...(open ? [{ id: "resolve", l: "Resolve", prompt: { title: "Resolve", sub: a.explanation, submit: "Resolve", fields: [{ k: "reason", l: "Why it is resolved", t: "area" as const, req: true, mic: true }] } }] : []),
          ],
        };
      }),
    };
  },
  forms: {
    async run(ctx) {
      if (!canRun(ctx)) return err("A manager runs the checks.", "not_permitted");
      const r = await runErpAlerts();
      if (r.skipped) return err(`Nothing ran: ${r.skipped}.`, "rule_violation");
      await erpAudit(ctx, "erp.alerts.run", "erp_alert", null, null, r);
      return okVoid(`${r.raised} new · ${r.resolved} cleared · ${r.open} open`);
    },
  },
  actions: {
    async ack(ctx, id, v) {
      const note = text(v.note);
      if (!note) return fieldErr("note", "Say what is being done about it");
      const mine = await visibleAlerts(ctx.screens, ctx.powers);
      if (!mine.some((a) => a.id === id)) return err("That alert is not on your account.", "not_permitted");
      await db.update(erpAlerts).set({ status: "Acknowledged", note, acknowledgedAt: new Date(), acknowledgedById: ctx.user.id }).where(eq(erpAlerts.id, id));
      await erpAudit(ctx, "erp.alert.ack", "erp_alert", id, null, { note });
      return okVoid("Acknowledged");
    },
    async resolve(ctx, id, v) {
      const reason = text(v.reason);
      if (!reason) return fieldErr("reason", "Say why it is resolved");
      const mine = await visibleAlerts(ctx.screens, ctx.powers);
      if (!mine.some((a) => a.id === id)) return err("That alert is not on your account.", "not_permitted");
      await db.update(erpAlerts).set({ status: "Resolved", resolveReason: reason, resolvedAt: new Date(), resolvedById: ctx.user.id }).where(inArray(erpAlerts.id, [id]));
      await erpAudit(ctx, "erp.alert.resolve", "erp_alert", id, null, { reason });
      return okVoid("Resolved");
    },
  },
};
