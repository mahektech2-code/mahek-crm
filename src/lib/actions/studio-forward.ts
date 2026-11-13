"use server";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, studioForwardRecipients, studioForwards } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { resolveScope } from "@/lib/access-control";
import { requireUser } from "@/lib/auth";
import { waLink } from "@/lib/erp/engines/logistics";
import { err, ok, type Result } from "@/lib/result";
import { alreadyForwarded, canMove, captionProblem, checkRecipientIds, FORWARD_STATUSES, type ForwardStatus } from "@/lib/studio/domain/forward";
import { alreadySentTo, getForward } from "@/lib/studio/forward-service";
import { getRecipient, recipientsByIds } from "@/lib/studio/recipients";

/* ---------------------------------------------------------------------------
 * Upload & Bulk Forward — the writes. A server action is a URL: every one
 * re-checks the grant, the ownership and the scope, and never trusts the page.
 * MahekOne SENDS NOTHING. A status is what the person working the list said.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

async function guard() {
  const user = await requireUser();
  if (!(await canOpenModule(user.id, "studio.forward"))) return null;
  return user;
}

export type StartInput = { forwardId: string; customerIds: string[]; caption: string; includeRepeats?: boolean };
export type StartResult = { started: number; skipped: { name: string; reason: string }[]; repeats?: { id: string; name: string }[] };

export async function startForward(input: StartInput): Promise<Result<StartResult>> {
  const user = await guard();
  if (!user) return err("You do not have this part of the Studio.", "not_permitted");
  const forward = await getForward(user.id, input.forwardId);
  if (!forward) return err("That poster was not found.", "not_found");
  if (forward.status !== "draft") return err("This forward has already been started. Open it to carry on.", "conflict");
  const cp = captionProblem(input.caption ?? "");
  if (cp) return err(cp);
  const checked = checkRecipientIds(input.customerIds ?? []);
  if (!checked.ok) return err(checked.error);

  const { scope } = await resolveScope();
  const found = await recipientsByIds(scope.userIds, checked.ids);
  const byId = new Map(found.map((r) => [r.id, r]));
  /* Anything out of scope is simply absent. A request naming one is refused whole, so a tampered request cannot half-run. */
  if (found.length !== checked.ids.length) return err("Some of those people are not in your book. Choose from your own list and try again.", "not_permitted");

  const skipped: { name: string; reason: string }[] = [];
  const usable = checked.ids.filter((id) => {
    const r = byId.get(id)!;
    if (r.doNotContact) {
      skipped.push({ name: r.company, reason: "Marked Do Not Contact" });
      return false;
    }
    return true;
  });
  if (!usable.length) return err("Everybody chosen is marked Do Not Contact, so there is nobody to forward to.");

  const earlier = await alreadySentTo(user.id, forward.sha256, forward.id, usable);
  const { fresh, repeats } = alreadyForwarded(usable, earlier);
  if (repeats.length && !input.includeRepeats) {
    return ok({ started: 0, skipped, repeats: repeats.map((id) => ({ id, name: byId.get(id)!.company })) });
  }
  const final = input.includeRepeats ? usable : fresh;
  if (!final.length) return err("You have already forwarded this poster to everybody chosen.", "conflict");

  try {
    await db.transaction(async (tx) => {
      /* The status guard is the double-click guard: only the call that finds a draft starts it. */
      const claimed = await tx
        .update(studioForwards)
        .set({ status: "started", startedAt: new Date(), caption: input.caption ?? "" })
        .where(and(eq(studioForwards.id, forward.id), eq(studioForwards.status, "draft")))
        .returning({ id: studioForwards.id });
      if (!claimed.length) throw new Error("already_started");
      await tx.insert(studioForwardRecipients).values(
        final.map((id) => {
          const r = byId.get(id)!;
          return { id: newId("fwr"), forwardId: forward.id, customerId: id, company: r.company, place: [r.city, r.state].filter(Boolean).join(", ") };
        }),
      );
      await tx.insert(auditLog).values({
        id: newId("aud"),
        actorId: user.id,
        action: "studio.forward.started",
        entityType: "studio_forward",
        entityId: forward.id,
        afterState: { recipients: final.length, skipped: skipped.length, repeatsIncluded: input.includeRepeats ? repeats.length : 0 } as never,
      });
    });
  } catch (e) {
    if (e instanceof Error && e.message === "already_started") return err("This forward has already been started. Open it to carry on.", "conflict");
    console.error("[studio] forward start failed:", e instanceof Error ? e.message : e);
    return err("The forward could not be started. Try again.");
  }
  return ok({ started: final.length, skipped });
}

async function ownedRecipient(userId: string, recipientId: string) {
  const [row] = await db
    .select({ r: studioForwardRecipients, caption: studioForwards.caption })
    .from(studioForwardRecipients)
    .innerJoin(studioForwards, eq(studioForwards.id, studioForwardRecipients.forwardId))
    .where(and(eq(studioForwardRecipients.id, recipientId), eq(studioForwards.createdById, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Opens their chat. The number is read here, on the server, and handed back
 * only for this one press; the page never carries a list of phone numbers.
 * Opening a chat is NOT sending: the status says "Chat opened" and no more.
 */
export async function openRecipientChat(recipientId: string): Promise<Result<{ href: string }>> {
  const user = await guard();
  if (!user) return err("You do not have this part of the Studio.", "not_permitted");
  const row = await ownedRecipient(user.id, recipientId);
  if (!row) return err("That recipient was not found.", "not_found");
  if (!row.r.customerId) return err("The record is no longer in your book, so there is no number to open a chat on.");
  const { scope } = await resolveScope();
  const rec = await getRecipient(scope.userIds, row.r.customerId);
  if (!rec) return err("The record is no longer in your book, so there is no number to open a chat on.");
  if (rec.doNotContact) return err("Marked Do Not Contact — no chat is offered.");
  if (rec.whatsappDnd) return err("They asked not to be messaged on WhatsApp — no chat is offered.");
  const href = waLink(rec.whatsappPhone, row.caption);
  if (!href) return err("There is no usable phone number on their record.");
  if (row.r.status === "pending") {
    await db
      .update(studioForwardRecipients)
      .set({ status: "opened", openedAt: new Date() })
      .where(and(eq(studioForwardRecipients.id, recipientId), eq(studioForwardRecipients.status, "pending")));
  }
  return ok({ href });
}

export async function markRecipient(recipientId: string, status: ForwardStatus, note?: string): Promise<Result> {
  const user = await guard();
  if (!user) return err("You do not have this part of the Studio.", "not_permitted");
  if (!(FORWARD_STATUSES as readonly string[]).includes(status)) return err("Not a valid status.");
  const row = await ownedRecipient(user.id, recipientId);
  if (!row) return err("That recipient was not found.", "not_found");
  if (!canMove(row.r.status as ForwardStatus, status)) return ok(undefined);
  await db.transaction(async (tx) => {
    await tx
      .update(studioForwardRecipients)
      .set({ status, decidedAt: status === "pending" ? null : new Date(), decidedById: status === "pending" ? null : user.id, note: note?.trim().slice(0, 200) || null })
      .where(eq(studioForwardRecipients.id, recipientId));
    await tx.insert(auditLog).values({
      id: newId("aud"),
      actorId: user.id,
      action: "studio.forward.recipient",
      entityType: "studio_forward",
      entityId: row.r.forwardId,
      afterState: { recipient: recipientId, from: row.r.status, to: status } as never,
    });
  });
  return ok(undefined);
}

export type PickRow = { id: string; company: string; contact: string | null; place: string; doNotContact: boolean };

/** The picker's list, read through the same scope as every other Studio list. No phone number leaves the server. */
export async function searchRecipients(list: string, q: string, page = 1): Promise<Result<{ rows: PickRow[]; total: number; pageCount: number }>> {
  const user = await guard();
  if (!user) return err("You do not have this part of the Studio.", "not_permitted");
  const { isRecipientList, listRecipients } = await import("@/lib/studio/recipients");
  if (!isRecipientList(list)) return err("Not a list.");
  const { scope } = await resolveScope();
  const res = await listRecipients({ userIds: scope.userIds, list, q: q.slice(0, 80), page, pageSize: 50 });
  return ok({
    rows: res.rows.map((r) => ({ id: r.id, company: r.company, contact: r.contact, place: [r.city, r.state].filter(Boolean).join(", "), doNotContact: r.doNotContact })),
    total: res.total,
    pageCount: res.pageCount,
  });
}
