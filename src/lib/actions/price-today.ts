"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requirePriceDesk } from "@/lib/services/price-desk";
import { audit } from "@/lib/services/price-write";
import { runJob } from "@/lib/jobs";
import { err, fieldErr, fromThrown, ok, okVoid, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * PRICE DESK · TODAY — the two writes the screen makes: dismiss a morning
 * check finding (with a note saying why), and run the check now.
 *
 * Both are the Price Desk's: a server action is a URL, so the CRM's read-only
 * door drawing no buttons is not what stops a telecaller dismissing a finding.
 * ------------------------------------------------------------------------- */

function refresh() {
  try {
    for (const base of ["/accounts/price-lists", "/founder/price-lists", "/crm/price-lists"]) revalidatePath(`${base}/today`);
  } catch {
    /* No request context — a test. */
  }
}

/** A finding, set aside for the day with a note. Re-running the check does not raise it again today. */
export async function dismissFinding(id: string, note: string): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    const text = (note ?? "").trim();
    if (!text) return fieldErr("note", "Say why this can be set aside — the next person reads it.");
    if (text.length > 1000) return fieldErr("note", "Keep the note under 1,000 characters.");
    const rows = await db.execute<{ id: string }>(sql`
      update price_book_findings
         set dismissed_at = now(), dismissed_by_id = ${ctx.user.id}, dismiss_note = ${text}
       where id = ${id} and dismissed_at is null
      returning id
    `);
    if (![...rows].length) {
      const [exists] = await db.execute<{ id: string }>(sql`select id from price_book_findings where id = ${id}`);
      return exists ? err("That finding was already dismissed.", "conflict") : err("That finding no longer exists.", "not_found");
    }
    await audit(db, ctx, { action: "pricebook.finding.dismiss", entityType: "price_book_finding", entityId: id, after: { note: text } });
    refresh();
    return okVoid("Dismissed for today.");
  } catch (e) {
    return fromThrown(e);
  }
}

/** Run the morning check for today, now. */
export async function runMorningCheckNow(): Promise<Result<{ detail: string }>> {
  try {
    const ctx = await requirePriceDesk();
    const [r] = await runJob("price-books-morning", ctx.user.id);
    refresh();
    return ok({ detail: r?.detail ?? "" }, r?.detail ? `Checked: ${r.detail}.` : "Checked.");
  } catch (e) {
    return fromThrown(e);
  }
}
