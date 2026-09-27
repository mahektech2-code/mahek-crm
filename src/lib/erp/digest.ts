import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { erpDigests } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { write } from "@/lib/writing-model";
import { addDaysIso } from "./engines/sales";
import { ALERT_LABEL, type AlertKind } from "./engines/alerts";
import { today } from "./screens/common";

/* ---------------------------------------------------------------------------
 * AI-4's owner's summary: yesterday in one paragraph, on the dashboard.
 *
 * It carries COUNTS ONLY — no rate, amount, cost or margin — so every person
 * who can open the dashboard may read it (AI PRD principle 5). The figures
 * are gathered by code; the writing model only puts them into sentences, and
 * where no model is configured a plain rule-built paragraph stands in, so the
 * summary never depends on a provider being up.
 * ------------------------------------------------------------------------- */

export type DigestFacts = {
  day: string;
  ordersTaken: number;
  linesDispatched: number;
  purchasesReceived: number;
  batchesMade: number;
  openAlerts: { kind: string; n: number }[];
};

async function facts(day: string): Promise<DigestFacts> {
  const one = async (q: ReturnType<typeof sql>) => Number(((await db.execute(q)) as unknown as { n: number }[])[0]?.n ?? 0);
  const [ordersTaken, linesDispatched, purchasesReceived, batchesMade, alerts] = await Promise.all([
    one(sql`select count(distinct order_no)::int as n from erp_orders where order_date = ${day}`),
    one(sql`select count(*)::int as n from erp_order_details where dispatch_date = ${day} and verification = 'Verified'`),
    one(sql`select count(*)::int as n from erp_inward where received_date = ${day}`),
    one(sql`select count(distinct sfg_no)::int as n from erp_sfg_lines where batch_date = ${day}`),
    db.execute(sql`select kind, count(*)::int as n from erp_alerts where status <> 'Resolved' group by kind order by n desc`) as unknown as Promise<{ kind: string; n: number }[]>,
  ]);
  return { day, ordersTaken, linesDispatched, purchasesReceived, batchesMade, openAlerts: alerts.map((a) => ({ kind: a.kind, n: Number(a.n) })) };
}

/** The rule-built paragraph: exact, and what stands when no model is configured. */
export function plainDigest(f: DigestFacts): string {
  const alerts = f.openAlerts.length
    ? `Open alerts: ${f.openAlerts.map((a) => `${a.n} ${ALERT_LABEL[a.kind as AlertKind] ?? a.kind}`.toLowerCase()).join(", ")}.`
    : "No alerts are open.";
  return `On ${f.day}: ${f.ordersTaken} order${f.ordersTaken === 1 ? "" : "s"} taken, ${f.linesDispatched} line${f.linesDispatched === 1 ? "" : "s"} dispatched, ${f.purchasesReceived} inward line${f.purchasesReceived === 1 ? "" : "s"} received and ${f.batchesMade} SFG batch${f.batchesMade === 1 ? "" : "es"} made. ${alerts}`;
}

export async function writeErpDigest(): Promise<{ day: string; servedBy: string; text: string }> {
  const day = addDaysIso(today(), -1);
  const f = await facts(day);
  const plain = plainDigest(f);
  let text = plain;
  let servedBy = "rules";
  const c = await getConfig();
  if (c["erp.ai.alerts.enabled"]) {
    const w = await write({
      openaiModel: c["voice.languageModel"],
      system:
        "You write a two-to-three sentence morning summary for the owner of a paint manufacturer. Use ONLY the figures given. Do not add numbers, causes, advice or adjectives about performance. Plain English.",
      prompt: plain,
      timeoutMs: 20_000,
    });
    if (w.ok) {
      text = w.text;
      servedBy = w.servedBy;
    }
  }
  await db
    .insert(erpDigests)
    .values({ day, text, servedBy })
    .onConflictDoUpdate({ target: erpDigests.day, set: { text, servedBy, createdAt: new Date() } });
  return { day, servedBy, text };
}
