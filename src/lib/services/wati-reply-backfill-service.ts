import "server-only";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, waReplies } from "@/db/schema";
import { err, ok, type Result } from "../result";
import { listWatiContacts, watiHistoryPage, type WatiHistoryItem } from "../wati";
import { announceWa } from "../wa-live";
import { customerIdForNumber } from "./whatsapp-service";
import { requireFounderDesk } from "./whatsapp-switch-service";

/* ---------------------------------------------------------------------------
 * REPLIES FROM BEFORE THE WEBHOOK, read back from Wati.
 *
 * The webhook only carries what happens after it was set up, and for weeks it
 * was not — so customers' answers to the first reminders ("Already paid",
 * "bill bhej dijiye") sat in Wati's inbox and nowhere in MahekOne. This walks
 * every contact on the business number, reads each conversation back, and
 * files what the CUSTOMER wrote exactly as the webhook would have: matched to
 * a customer by number (`customerIdForNumber`, the webhook's own rule), and
 * kept against nobody where no customer has that number.
 *
 * It cannot double anything up. A reply is keyed by WhatsApp's own message id
 * — the key the webhook files under, unique on `wa_replies` — so a message
 * the webhook already delivered, or one an earlier run brought in, is skipped,
 * and running it twice is the same as running it once.
 *
 * A reply somebody already answered inside Wati comes in HANDLED: an agent's
 * message after it in the same conversation is the answer, and putting it on
 * a telecaller's Needs-reply list a week later would be asking them to do it
 * twice. One with no answer after it comes in waiting, which is the point.
 *
 * Only what customers wrote is imported. Our own templates are already in the
 * message log; replies typed by an agent inside Wati have no person in
 * MahekOne to file them under, so they decide "handled" and are not copied.
 *
 * The founder's desk runs it — the same grant that turns sending on — with a
 * preview that counts and writes nothing.
 * ------------------------------------------------------------------------- */

/** How far back a conversation is read. Older than this was dealt with long ago. */
export const BACKFILL_DAYS = 90;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export type BackfillSummary = {
  dryRun: boolean;
  contacts: number;
  /** Customer messages found in the window. */
  found: number;
  /** New to MahekOne — imported, or that would be in a preview. */
  imported: number;
  /** Already here, through the webhook or an earlier run. */
  alreadyHere: number;
  /** Of the new ones: filed against a customer or lead, or against nobody. */
  matched: number;
  unmatched: number;
  /** Of the new ones: already answered inside Wati, so they arrive handled. */
  answeredInWati: number;
  oldest: string | null;
  newest: string | null;
  /** Conversations Wati would not give us, and why. */
  failed: Array<{ waId: string; error: string }>;
};

type Found = {
  providerMessageId: string;
  waId: string;
  senderName: string | null;
  text: string;
  at: Date;
  answered: boolean;
};

/** What the customer said, from one conversation, newest first as Wati sends it. */
function customerMessages(items: WatiHistoryItem[], waId: string, name: string | null, since: number): Found[] {
  // Oldest first, so "is there an answer after it" is a look forward.
  const ordered = [...items]
    .filter((i) => i.eventType === "message" && Date.parse(i.created) >= since)
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  const out: Found[] = [];
  ordered.forEach((m, idx) => {
    if (m.owner !== false) return;
    const text = (typeof m.text === "string" && m.text.trim()) || `[${m.type ?? "message"}]`;
    out.push({
      providerMessageId: m.whatsappMessageId || `wati:${m.id}`,
      waId,
      senderName: name,
      text: text.slice(0, 4000),
      at: new Date(m.created),
      answered: ordered.slice(idx + 1).some((later) => later.owner === true),
    });
  });
  return out;
}

export async function backfillWatiReplies(input: { dryRun: boolean }): Promise<Result<BackfillSummary>> {
  const ctx = await requireFounderDesk();
  const since = Date.now() - BACKFILL_DAYS * 86_400_000;

  const contacts = await listWatiContacts();
  if (!contacts.ok) return err(`Could not read Wati's contacts: ${contacts.error}`, "rule_violation");

  const found: Found[] = [];
  const failed: BackfillSummary["failed"] = [];
  for (const c of contacts.contacts) {
    if (c.lastUpdated && Date.parse(c.lastUpdated) < since) continue;
    const items: WatiHistoryItem[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await watiHistoryPage(c.waId, page, PAGE_SIZE);
      if (!r.ok) {
        failed.push({ waId: c.waId, error: r.error });
        break;
      }
      items.push(...r.items);
      const oldest = r.items.at(-1);
      if (r.items.length < PAGE_SIZE || (oldest && Date.parse(oldest.created) < since)) break;
    }
    found.push(...customerMessages(items, c.waId, c.name, since));
  }

  // What MahekOne already holds, by the same key the webhook files under.
  const existing = new Set<string>();
  for (let i = 0; i < found.length; i += 500) {
    const ids = found.slice(i, i + 500).map((f) => f.providerMessageId);
    if (!ids.length) continue;
    const rows = await db
      .select({ id: waReplies.providerMessageId })
      .from(waReplies)
      .where(inArray(waReplies.providerMessageId, ids));
    for (const r of rows) if (r.id) existing.add(r.id);
  }
  const fresh = found.filter((f) => !existing.has(f.providerMessageId));

  // Matched once per number, not once per message.
  const owner = new Map<string, string | null>();
  for (const f of fresh) {
    const last10 = f.waId.replace(/\D/g, "").slice(-10);
    if (!owner.has(last10)) owner.set(last10, await customerIdForNumber(last10));
  }
  const ownerOf = (f: Found) => owner.get(f.waId.replace(/\D/g, "").slice(-10)) ?? null;

  let written = 0;
  if (!input.dryRun && fresh.length) {
    const now = new Date();
    for (let i = 0; i < fresh.length; i += 200) {
      const chunk = fresh.slice(i, i + 200);
      const inserted = await db
        .insert(waReplies)
        .values(
          chunk.map((f) => ({
            id: `war_${randomUUID().slice(0, 12)}`,
            customerId: ownerOf(f),
            message: f.text,
            receivedAt: f.at,
            waId: f.waId,
            senderName: f.senderName,
            providerMessageId: f.providerMessageId,
            // Answered inside Wati already: handled, and said so by nobody in
            // particular — the answer was not given by anyone in MahekOne.
            actioned: f.answered,
            actionedAt: f.answered ? now : null,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: waReplies.id });
      written += inserted.length;
    }
    await db.insert(auditLog).values({
      id: `aud_${randomUUID().slice(0, 12)}`,
      actorId: ctx.user.id,
      actorRole: ctx.authorisedBy,
      actorApp: ctx.authorisedIn,
      action: "whatsapp.replies_backfilled",
      entityType: "wa_reply",
      entityId: null,
      afterState: { imported: written, found: found.length, days: BACKFILL_DAYS } as never,
    });
    // Every open chat screen re-reads the conversations that grew.
    const touched = new Map<string, { customerId: string | null; number: string }>();
    for (const f of fresh) {
      const number = f.waId.replace(/\D/g, "").slice(-10);
      touched.set(number, { customerId: ownerOf(f), number });
    }
    for (const t of touched.values()) await announceWa(t);
  }

  const times = fresh.map((f) => f.at.getTime());
  const summary: BackfillSummary = {
    dryRun: input.dryRun,
    contacts: contacts.contacts.length,
    found: found.length,
    imported: input.dryRun ? fresh.length : written,
    alreadyHere: found.length - fresh.length,
    matched: fresh.filter((f) => ownerOf(f)).length,
    unmatched: fresh.filter((f) => !ownerOf(f)).length,
    answeredInWati: fresh.filter((f) => f.answered).length,
    oldest: times.length ? new Date(Math.min(...times)).toISOString() : null,
    newest: times.length ? new Date(Math.max(...times)).toISOString() : null,
    failed,
  };
  const n = summary.imported;
  return ok(
    summary,
    input.dryRun
      ? `${n} ${n === 1 ? "reply" : "replies"} would come in`
      : `${n} ${n === 1 ? "reply" : "replies"} brought in from Wati`,
  );
}
