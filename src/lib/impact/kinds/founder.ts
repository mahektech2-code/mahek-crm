import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { describeRule } from "@/lib/whatsapp-rules";
import { listRules, ruleAudience } from "@/lib/services/whatsapp-automation-service";
import { requireFounderDesk } from "@/lib/services/whatsapp-switch-service";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";

/* ---------------------------------------------------------------------------
 * A FOUNDER'S WHATSAPP RULE is the one thing in MahekOne that messages
 * customers on its own. Deleting one is the founder saying "stop", and what
 * that stops is a list of real shops: the ones it would reach on its next
 * scheduled check, worked out by the same pass the "who does this reach"
 * button runs — read only, nothing sent, nothing logged.
 *
 * What it already sent stays in the message log; nothing about a customer's
 * history is rewritten.
 *
 * `requireFounderDesk`, the gate the delete itself goes through.
 * ------------------------------------------------------------------------- */

/** `founder-wa-rule` — `deleteRuleAction`. */
export const waRuleImpact: ImpactSource = {
  async authorize() {
    await requireFounderDesk();
  },
  async report(id) {
    const rule = (await listRules()).find((r) => r.id === id);
    if (!rule) return null;

    const items: ImpactItem[] = [
      {
        app: "Founder",
        label: "automation rule",
        effect: "deleted",
        count: 1,
        examples: [`${rule.templateName}: ${describeRule(rule)}`],
      },
    ];

    if (rule.status !== "off") {
      const audience = (await ruleAudience(id)).rules.find((r) => r.ruleId === id);
      const reached = (audience?.rows ?? []).filter((r) => r.outcome === "would_send" || r.outcome === "sent");
      items.push({
        app: "CRM",
        label: reached.length === 1 ? "customer it would message on its next run" : "customers it would message on its next run",
        effect: "changed",
        count: reached.length,
        examples: reached.slice(0, 5).map((r) => r.customerName),
        note:
          rule.status === "live"
            ? "It is live: from the next scheduled check they are not sent this message by this rule. Another rule may still reach them."
            : "It is in preview, so nothing is sent today — what stops is the log of what it would have sent.",
      });
    }

    const [sent] = await db.execute<{ n: number }>(sql`select count(*)::int as n from wa_messages where trigger_id = ${id}`);
    items.push({
      app: "Founder",
      label: Number(sent?.n) === 1 ? "message it already sent" : "messages it already sent",
      effect: "kept",
      count: Number(sent?.n ?? 0),
      note: "They stay in the message log and on each customer's record.",
    });

    const name = rule.templateName;
    return {
      title: `the rule for ${name}`,
      verb: "Delete",
      confirmWord: name.length <= 40 ? name : "DELETE",
      items,
      blockers: [],
    };
  },
};
