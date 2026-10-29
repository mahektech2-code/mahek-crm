"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { CRM_EVENT, writeTimelineEvent } from "@/lib/timeline";
import {
  FOLLOWUP_CODES,
  followUpSentence,
  followUpMaterial,
  type FollowUpCode,
  type FollowUpStatus,
} from "@/lib/lead-followup";
import { publishedDocuments } from "@/lib/services/lead-console-service";
import { leadRow } from "@/lib/services/lead-service";
import { reachLead } from "@/lib/services/lead-reach-service";

/* ---------------------------------------------------------------------------
 * A FOLLOW-UP IS A RECORD THAT SOMEBODY STARTED ONE, never a call and never a send.
 *
 * The call form opens the lead's WhatsApp conversation and calls this to write
 * down WHICH option was chosen, by whom and when: a timeline entry on the lead
 * and an audit row. It writes no `calls` row (so it is not Call N, answers no
 * qualification question and cannot satisfy a gate), changes no stage and no
 * owner, and says "WhatsApp opened" — never "sent": only the WhatsApp screen,
 * from the integration's own confirmation, can say a message went.
 *
 * Who may: `lead.work` and THIS lead in their scope, the same pair a call asks.
 * A published file for the category, where there is one, is named in the entry —
 * resolved HERE on the server, never taken from the page — but none is required:
 * the person composes the message in WhatsApp themselves.
 * ------------------------------------------------------------------------- */

const schema = z.object({
  customerId: z.string().min(1),
  materials: z.array(z.enum(FOLLOWUP_CODES as unknown as [FollowUpCode, ...FollowUpCode[]])).min(1).max(3),
  remarks: z.string().trim().max(2000).optional(),
  /** True when the WhatsApp conversation was opened for it. */
  whatsappOpened: z.boolean().default(true),
  /** One per click: a retried request must not write the entry twice. */
  clientKey: z.string().regex(/^[\w-]{8,80}$/),
});

export async function recordLeadFollowUp(
  input: z.input<typeof schema>,
): Promise<Result<{ recorded: number; status: FollowUpStatus; at: string }>> {
  try {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return err("Pick what to send.", "validation");
    const p = parsed.data;

    const ctx = await requireCapability("lead.work");
    const lead = await leadRow(p.customerId);
    if (!lead || lead.kind !== "lead") return err("That lead is not on MahekOne.", "not_found");
    await reachLead(lead, ctx.user.id);

    const docs = await publishedDocuments();
    const materials = [...new Set(p.materials)];
    const status: FollowUpStatus = p.whatsappOpened ? "whatsapp_opened" : "requested";
    const now = new Date();

    await db.transaction(async (tx) => {
      for (const code of materials) {
        const doc = docs[followUpMaterial(code).category];
        await writeTimelineEvent(tx, {
          customerId: lead.id,
          eventType: CRM_EVENT.followUp,
          sourceApp: "crm",
          /* THE MATERIAL GOES IN THE SOURCE ID: one click, one event per material. */
          sourceRecordId: `fup_${p.clientKey}:${code}`,
          occurredAt: now,
          actorUserId: ctx.user.id,
          summary: followUpSentence(code, doc?.title ?? null, status) + (p.remarks ? ` · ${p.remarks}` : ""),
        });
      }
      await tx
        .insert(auditLog)
        .values({
          id: `aud_fup_${p.clientKey}`,
          actorId: ctx.user.id,
          action: "lead.followup.request",
          entityType: "customer",
          entityId: lead.id,
          actorRole: ctx.authorisedBy,
          actorApp: ctx.authorisedIn,
          beforeState: null,
          afterState: { materials, status },
        })
        .onConflictDoNothing();
    });

    try {
      revalidatePath(`/crm/leads/${lead.id}`);
    } catch {
      /* no request context - a job or a test, where nothing is cached */
    }
    return ok(
      { recorded: materials.length, status, at: now.toISOString() },
      status === "whatsapp_opened"
        ? "Follow-up recorded — WhatsApp opened. It is not marked sent."
        : "Follow-up recorded — not marked sent.",
    );
  } catch (e) {
    return fromThrown(e);
  }
}
