"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { notifications } from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { BULK_DEAD_MAX, deadRequestEligibility } from "@/lib/lead-dead";
import { REASON_CODE_NEEDING_REMARKS } from "@/lib/lead-labels";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { assertLeadInScope } from "@/lib/services/lead-scope";
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
    const sent = await requestOne(ctx, p.customerId, p.reasonCode, p.note, false);
    refresh();
    return sent.ok ? ok(null, sent.message) : sent;
  } catch (e) {
    return fromThrown(e);
  }
}

type Actor = Awaited<ReturnType<typeof requireCapability>>;

/**
 * ONE LEAD'S REQUEST — the checks `requestDeadLead` has always made, in one
 * place so the single door and the batch cannot come apart: the lead exists, is
 * in this person's reach, is a Lost lead nobody has already killed or asked
 * about, and then the service asks again under the row lock. A refusal (a scope
 * error included) comes back as a result, so a batch can name it and carry on.
 */
async function requestOne(
  ctx: Actor,
  customerId: string,
  reasonCode: string,
  note: string | undefined,
  quiet: boolean,
) {
  try {
    const lead = await leadRow(customerId);
    if (!lead) return err("That lead is not on MahekOne.", "not_found");
    /* Asked the way the lead LISTS ask it (`assertLeadInScope`): a lead on this
       person's list — through her team or her Sales Manager seat — is one she may
       work. The bare CRM scope check refused it with a sentence about levels. */
    await assertLeadInScope(customerId, {
      kind: lead.kind,
      ownerId: lead.ownerId,
      salesAmId: lead.salesAmId,
      backOfficeAmId: lead.backOfficeAmId,
      leadManagerId: lead.leadManagerId,
      salesManagerId: lead.salesManagerId,
    });

    /* Eligibility, read from the database rather than from anything the client
       said — and asked again inside the service under the row lock. */
    const facts = await deadFactsOf(customerId);
    const eligibility = deadRequestEligibility({
      stage: lead.leadStage,
      deadAt: facts.deadAt,
      pending: Boolean(facts.pendingRequestId),
    });
    if (!eligibility.offer) return err(eligibility.reason, "rule_violation");

    return await requestLeadDead({
      actorUserId: ctx.user.id,
      hat: { app: ctx.authorisedIn, role: ctx.authorisedBy },
      customerId,
      reasonCode,
      note,
      quiet,
    });
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------- several at once */

const bulkSchema = z.object({
  customerIds: z.array(z.string().min(1)).min(1, "Pick at least one lead.").max(BULK_DEAD_MAX, `At most ${BULK_DEAD_MAX} leads at once.`),
  reasonCode: z.string().trim().min(1, "Why are they Dead?").max(60),
  note: z.string().trim().max(1000).optional(),
});

export type BulkDeadResult = {
  /** How many requests were raised — one per lead, each decided on its own. */
  requested: number;
  approverName: string | null;
  /** Leads that were NOT sent, each with the sentence the single action would have given. */
  refused: Array<{ id: string; name: string; why: string }>;
};

/**
 * MARK SEVERAL LOST LEADS AS DEAD — every selected lead goes for approval.
 *
 * Not a second path to Dead: each lead goes through exactly the checks and the
 * service the single request uses (`requestOne`), so each gets its own request,
 * its own audit row and timeline entry, and its own decision by the approver —
 * who is the same person for the whole batch, fixed from the Org Chart above
 * the person asking. Sequential, so a lead refused part-way is named and the
 * others still go. The approver gets ONE bell message for the batch, not one per
 * lead.
 */
export async function requestDeadLeads(input: z.input<typeof bulkSchema>): Promise<Result<BulkDeadResult>> {
  try {
    const parsed = bulkSchema.safeParse(input);
    if (!parsed.success) {
      return err(parsed.error.issues[0]?.message ?? "Pick why they are Dead.", "validation");
    }
    const p = parsed.data;
    const ids = [...new Set(p.customerIds)];
    const ctx = await requireCapability("lead.work");

    /* What cannot differ from lead to lead is settled once, up front, so a bad
       reason or an Org Chart that cannot name an approver is said ONCE and not
       once per lead. */
    const config = await getConfig();
    if (!config["leads.deadReasons"].some((r) => r.code === p.reasonCode)) {
      return err("Pick one of the listed reasons for marking these leads Dead.", "validation");
    }
    if (p.reasonCode === REASON_CODE_NEEDING_REMARKS && !p.note) {
      return err("You picked Other — say in words why these leads are Dead.", "validation");
    }
    const routed = await resolveDeadApprover(ctx.user.id);
    if (!routed.ok) return err(routed.message, "rule_violation");

    const refused: BulkDeadResult["refused"] = [];
    let requested = 0;
    let approver: { id: string; name: string } | null = null;
    for (const id of ids) {
      const sent = await requestOne(ctx, id, p.reasonCode, p.note, true);
      if (sent.ok) {
        requested += 1;
        approver = { id: sent.data.approverUserId, name: sent.data.approverName };
      } else {
        const row = await leadRow(id).catch(() => null);
        refused.push({ id, name: row?.name ?? id, why: sent.error });
      }
    }

    if (requested > 0 && approver) {
      await db.insert(notifications).values({
        id: `ntf_${randomUUID().slice(0, 12)}`,
        userId: approver.id,
        title: `${requested} Dead ${requested === 1 ? "request" : "requests"} from ${ctx.user.name}`,
        body: `${ctx.user.name} asked to mark ${requested} ${requested === 1 ? "lead" : "leads"} permanently Dead. Each is decided on its own; approving locks that lead for ever.`,
        kind: "warn",
        href: "/crm/leads/dead?tab=queue",
      });
    }
    refresh();
    return ok(
      { requested, approverName: approver?.name ?? null, refused },
      requested
        ? `${requested} ${requested === 1 ? "lead" : "leads"} sent to ${approver?.name} for approval${refused.length ? `, ${refused.length} not sent` : ""}.`
        : "Nothing was sent.",
    );
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
