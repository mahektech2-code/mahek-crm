"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { assertCustomerInScope, requireCapability } from "@/lib/access-control";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { deadRequestEligibility } from "@/lib/lead-dead";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { leadRow } from "@/lib/services/lead-service";
import {
  decideLeadDead,
  deadFactsOf,
  withdrawLeadDead,
  requestLeadDead,
  resolveDeadApprover,
} from "@/lib/services/lead-dead-service";

/* ---------------------------------------------------------------------------
 * MARK A LOST LEAD AS DEAD — the request, the manager's decision, and the
 * approver preview the dialog shows before anything is sent.
 *
 * Asking is `lead.work` plus the lead being in this person's scope, exactly as
 * every other write on a lead is, and ELIGIBILITY IS ENFORCED HERE: the menu
 * draws "Mark as Dead" on every lead and disables it on one that is not Lost,
 * but a menu is not a permission. Deciding is NOT a capability at all — the
 * approver was fixed from the Org Chart when the request was raised, and only
 * that person may decide it (`decideLeadDead` checks).
 * ------------------------------------------------------------------------- */

function refresh() {
  try {
    for (const path of ["/crm/leads", "/crm/leads/lost", "/crm/leads/dead", "/sales-lead-pipeline", "/crm/leads/sales-manager"]) {
      revalidatePath(path, "layout");
    }
  } catch {
    /* no request context — a job or a test, where nothing is cached */
  }
}

const requestSchema = z.object({
  customerId: z.string().min(1),
  reasonCode: z.string().trim().min(1, "Why is it Dead?").max(60),
  note: z.string().trim().max(1000).optional(),
});

export type DeadDialogFacts = {
  /** Who would decide it, or null where the Org Chart cannot say. */
  approverName: string | null;
  /** In words, where the request cannot be routed. */
  blocked: string | null;
  /** `leads.deadReasons`. */
  reasons: { code: string; label: string }[];
};

/** Who would decide this request, and what reasons are offered — read when the dialog opens. */
export async function previewDeadApprover(): Promise<Result<DeadDialogFacts>> {
  try {
    const user = await requireUser();
    const [r, config] = await Promise.all([resolveDeadApprover(user.id), getConfig()]);
    const reasons = config["leads.deadReasons"].map((x) => ({ code: x.code, label: x.label }));
    return ok(
      r.ok
        ? { approverName: r.approverName, blocked: null, reasons }
        : { approverName: null, blocked: r.message, reasons },
    );
  } catch (e) {
    return fromThrown(e);
  }
}

export async function requestDeadLead(input: z.input<typeof requestSchema>): Promise<Result<null>> {
  try {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) {
      return err(parsed.error.issues[0]?.message ?? "Pick why it is Dead.", "validation");
    }
    const p = parsed.data;

    const ctx = await requireCapability("lead.work");
    const lead = await leadRow(p.customerId);
    if (!lead) return err("That lead is not on MahekOne.", "not_found");
    await assertCustomerInScope({
      kind: lead.kind,
      ownerId: lead.ownerId,
      salesAmId: lead.salesAmId,
      backOfficeAmId: lead.backOfficeAmId,
      leadManagerId: lead.leadManagerId,
      salesManagerId: lead.salesManagerId,
    });

    /* Eligibility, read from the database rather than from anything the client
       said — and asked again inside the service under the row lock. */
    const facts = await deadFactsOf(p.customerId);
    const eligibility = deadRequestEligibility({
      stage: lead.leadStage,
      deadAt: facts.deadAt,
      pending: Boolean(facts.pendingRequestId),
    });
    if (!eligibility.offer) return err(eligibility.reason, "rule_violation");

    const sent = await requestLeadDead({
      actorUserId: ctx.user.id,
      hat: { app: ctx.authorisedIn, role: ctx.authorisedBy },
      customerId: p.customerId,
      reasonCode: p.reasonCode,
      note: p.note,
    });
    refresh();
    return sent.ok ? ok(null, sent.message) : sent;
  } catch (e) {
    return fromThrown(e);
  }
}

const decideSchema = z.object({
  requestId: z.string().min(1),
  approve: z.boolean(),
  note: z.string().trim().max(1000).optional(),
  /** Approval locks a lead for ever, so it has to be confirmed explicitly. */
  confirmed: z.boolean().optional(),
});

export async function decideDeadRequest(input: z.input<typeof decideSchema>): Promise<Result<null>> {
  try {
    const parsed = decideSchema.safeParse(input);
    if (!parsed.success) return err(parsed.error.issues[0]?.message ?? "Invalid request.", "validation");
    const p = parsed.data;
    if (p.approve && p.confirmed !== true) {
      return err(
        "Approving makes this lead permanently Dead and read-only. Confirm that you mean it.",
        "validation",
        [{ field: "confirmed", message: "Tick the confirmation." }],
      );
    }

    const user = await requireUser();
    const decided = await decideLeadDead({
      actorUserId: user.id,
      hat: null,
      requestId: p.requestId,
      approve: p.approve,
      note: p.note,
    });
    refresh();
    return decided;
  } catch (e) {
    return fromThrown(e);
  }
}

const withdrawSchema = z.object({ requestId: z.string().min(1) });

/**
 * Take a pending request back. Authorisation is the request itself: only the
 * person who asked may, checked under the row lock in `withdrawLeadDead`, so a
 * server action called by URL by anybody else is refused there.
 */
export async function withdrawDeadRequest(input: z.input<typeof withdrawSchema>): Promise<Result<null>> {
  try {
    const parsed = withdrawSchema.safeParse(input);
    if (!parsed.success) return err("Which request?", "validation");
    const user = await requireUser();
    const done = await withdrawLeadDead({ actorUserId: user.id, hat: null, requestId: parsed.data.requestId });
    refresh();
    return done;
  } catch (e) {
    return fromThrown(e);
  }
}
