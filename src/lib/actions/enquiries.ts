"use server";

import { revalidatePath } from "next/cache";
import {
  assignEnquiry,
  changeStage,
  changePriority,
  linkCustomer,
  addNote,
  createEnquiryReminder,
  linkOrder,
  unlinkOrder,
  findCustomersByPhone,
  enquiryForLeadConversion,
  createManualEnquiry,
  correctEnquiryDetails,
  editEnquiryNote,
  deleteEnquiryNote,
  rescheduleEnquiryReminder,
  cancelEnquiryReminder,
  markEnquirySpam,
  deleteEnquiry,
  noteRefusal,
  reminderRefusal,
  enquiriesRefusal,
  type CustomerMatch,
  type EnquiryForLead,
  type ManualEnquiryInput,
} from "@/lib/services/enquiry-service";
import type { CorrectableField } from "@/lib/enquiry-submission";
import { requireUser } from "@/lib/auth";
import { canOpenModule, listUserApps } from "@/lib/access";
import { canFor, requireCapability } from "@/lib/access-control";
import { DESK_MODULE, deskHolders, type DeskPerson } from "@/lib/services/lead-desk-assignment-service";
import { err, fromThrown, type Result } from "@/lib/result";
import { confirmImpact } from "@/lib/impact/registry";
import type { ImpactConfirmation } from "@/lib/impact/types";
import { impactPair } from "@/lib/impact/kinds/crm-keys";
import { db } from "@/db";
import { enquiryOrders } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  ENQUIRY_PRIORITIES,
  ENQUIRY_REMINDER_TYPES,
  ENQUIRY_STAGES,
  type EnquiryPriority,
  type EnquiryReminderType,
  type EnquiryStage,
} from "@/lib/enquiry-labels";

/** Is this order linked to this enquiry — the row the unlink would delete. */
async function isOrderLinked(enquiryId: string, orderId: string): Promise<boolean> {
  const [link] = await db
    .select({ id: enquiryOrders.id })
    .from(enquiryOrders)
    .where(and(eq(enquiryOrders.enquiryId, enquiryId), eq(enquiryOrders.orderId, orderId)));
  return Boolean(link);
}

/**
 * Thin over the service, which owns the access check. Every action here is
 * verified there, not merely hidden here — a disabled control is a courtesy,
 * not a permission.
 *
 * What the service cannot own is the SHAPE of what arrives. A server action is
 * a URL: `stage`, `priority` and a reminder's `type` are typed here and are all
 * Postgres enums underneath, so a value no dropdown can produce reaches the
 * database, which raises `invalid input value for enum …` — and `fromThrown`
 * puts that driver message in front of a telecaller as a toast. Every other
 * write path in this codebase checks what it was given before spending it.
 */
const isStage = (v: unknown): v is EnquiryStage =>
  typeof v === "string" && (ENQUIRY_STAGES as readonly string[]).includes(v);
const isPriority = (v: unknown): v is EnquiryPriority =>
  typeof v === "string" && (ENQUIRY_PRIORITIES as readonly string[]).includes(v);
const isReminderType = (v: unknown): v is EnquiryReminderType =>
  typeof v === "string" && (ENQUIRY_REMINDER_TYPES as readonly string[]).includes(v);

function refresh(enquiryId?: string) {
  try {
    revalidatePath("/enquiries");
    if (enquiryId) revalidatePath(`/enquiries/list/${enquiryId}`);
  } catch {
    /* no request context — nothing cached to invalidate */
  }
}

export async function assignEnquiryAction(enquiryId: string, assignToId: string | null): Promise<Result> {
  try {
    const r = await assignEnquiry(enquiryId, assignToId);
    refresh(enquiryId);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function changeStageAction(enquiryId: string, stage: EnquiryStage): Promise<Result> {
  if (!isStage(stage)) return err("That is not a stage an enquiry can be in.", "validation");
  try {
    const r = await changeStage(enquiryId, stage);
    refresh(enquiryId);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function changePriorityAction(enquiryId: string, priority: EnquiryPriority): Promise<Result> {
  if (!isPriority(priority)) return err("That is not a priority an enquiry can carry.", "validation");
  try {
    const r = await changePriority(enquiryId, priority);
    refresh(enquiryId);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function linkCustomerAction(enquiryId: string, customerId: string): Promise<Result> {
  try {
    const r = await linkCustomer(enquiryId, customerId);
    refresh(enquiryId);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function addNoteAction(enquiryId: string, note: string): Promise<Result> {
  try {
    const r = await addNote(enquiryId, note);
    refresh(enquiryId);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function createEnquiryReminderAction(input: {
  enquiryId: string;
  dueDate: string;
  note: string;
  type: EnquiryReminderType;
  assignedUserId: string;
}): Promise<Result> {
  if (!isReminderType(input.type)) return err("That is not a kind of reminder.", "validation");
  try {
    const r = await createEnquiryReminder(input);
    refresh(input.enquiryId);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function linkOrderAction(enquiryId: string, orderId: string): Promise<Result> {
  try {
    const r = await linkOrder(enquiryId, orderId);
    refresh(enquiryId);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function unlinkOrderAction(
  enquiryId: string,
  orderId: string,
  confirmation?: ImpactConfirmation,
): Promise<Result> {
  try {
    /* The Website Enquiries grant first — the service's own question — then
       the picture: the order itself stays, only the link goes. An order that
       is not linked has nothing to unlink, and the service says so. */
    const user = await requireUser();
    if (!(await listUserApps(user.id)).includes("enquiries")) {
      return err("Only somebody with Website Enquiries access can do that.", "not_permitted");
    }
    const linked = await isOrderLinked(enquiryId, orderId);
    if (linked) {
      const refusal = await confirmImpact("crm-enquiry-order", impactPair(enquiryId, orderId), confirmation);
      if (refusal) return refusal;
    }
    const r = await unlinkOrder(enquiryId, orderId);
    refresh(enquiryId);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function findCustomersByPhoneAction(phone: string): Promise<Result<CustomerMatch[]>> {
  try {
    return await findCustomersByPhone(phone);
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * What the Create lead dialog opens with: the enquiry's own facts, ready to
 * prefill, and whether this person may also hand the lead to somebody.
 *
 * A READ, and the same checks the write makes — the enquiry has to be one that
 * may become a lead and must not already have one — so a button is never drawn
 * for something the write would refuse. The lead itself is raised by
 * `captureLead`, not here: there is one way to make a lead.
 */
export type LeadFromEnquiryContext = {
  enquiry: EnquiryForLead;
  /** Whether this person may give the lead an owner as it is created. */
  canAssign: boolean;
  assignees: DeskPerson[];
};

export async function leadFromEnquiryContextAction(enquiryId: string): Promise<Result<LeadFromEnquiryContext>> {
  try {
    const found = await enquiryForLeadConversion(enquiryId);
    if (!found.ok) return found;
    const user = await requireUser();
    const canAssign = (await canFor(user, "lead.verify")) && (await canOpenModule(user.id, DESK_MODULE));
    return { ok: true, data: { enquiry: found.data, canAssign, assignees: canAssign ? await deskHolders() : [] } };
  } catch (e) {
    return fromThrown(e);
  }
}

/* ---------------------------------------------------------------------------
 * EDITS AND REMOVALS. The service owns the checks; the three that take
 * something away ask, in order, the service's own refusal, then the impact
 * confirmation — the person saw what goes, and it is still what goes — and
 * only then write. A call with no confirmation is refused before anything is
 * written, whatever the screen did.
 * ------------------------------------------------------------------------- */

export async function createManualEnquiryAction(input: ManualEnquiryInput): Promise<Result<{ id: string }>> {
  try {
    const r = await createManualEnquiry(input);
    refresh(r.ok ? r.data.id : undefined);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function correctEnquiryDetailsAction(
  enquiryId: string,
  fields: Partial<Record<CorrectableField, string | null>>,
): Promise<Result> {
  try {
    const r = await correctEnquiryDetails(enquiryId, fields ?? {});
    refresh(enquiryId);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function editEnquiryNoteAction(enquiryId: string, activityId: string, note: string): Promise<Result> {
  try {
    const r = await editEnquiryNote(enquiryId, activityId, typeof note === "string" ? note : "");
    refresh(enquiryId);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function deleteEnquiryNoteAction(
  enquiryId: string,
  activityId: string,
  confirmation?: ImpactConfirmation,
): Promise<Result> {
  try {
    const refused = await noteRefusal(enquiryId, activityId);
    if (refused) return refused;
    const unconfirmed = await confirmImpact("enquiry-note-delete", activityId, confirmation);
    if (unconfirmed) return unconfirmed;
    const r = await deleteEnquiryNote(enquiryId, activityId);
    refresh(enquiryId);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function rescheduleEnquiryReminderAction(
  enquiryId: string,
  reminderId: string,
  dueDate: string,
  note?: string,
): Promise<Result> {
  try {
    const r = await rescheduleEnquiryReminder(enquiryId, reminderId, dueDate, note);
    refresh(enquiryId);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function cancelEnquiryReminderAction(
  enquiryId: string,
  reminderId: string,
  reason: string,
  confirmation?: ImpactConfirmation,
): Promise<Result> {
  try {
    if (typeof reason !== "string" || !reason.trim()) {
      return err("Say why it is being cancelled.", "validation", [{ field: "reason", message: "A reason is required." }]);
    }
    const refused = await reminderRefusal(enquiryId, reminderId);
    if (refused) return refused;
    /* `reminder.close`, the capability `dismissReminder` asks — first, so a
       person without it is told that, not shown a picture they cannot act on. */
    await requireCapability("reminder.close");
    const unconfirmed = await confirmImpact("enquiry-reminder-cancel", reminderId, confirmation);
    if (unconfirmed) return unconfirmed;
    const r = await cancelEnquiryReminder(enquiryId, reminderId, reason);
    refresh(enquiryId);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function deleteEnquiryAction(
  enquiryId: string,
  reason: string | undefined,
  confirmation?: ImpactConfirmation,
): Promise<Result> {
  try {
    const refused = await enquiriesRefusal();
    if (refused) return refused;
    const unconfirmed = await confirmImpact("enquiry-delete", enquiryId, confirmation);
    if (unconfirmed) return unconfirmed;
    const r = await deleteEnquiry(enquiryId, typeof reason === "string" ? reason : undefined);
    try {
      revalidatePath("/enquiries", "layout");
    } catch {
      /* outside a request */
    }
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function markEnquirySpamAction(
  enquiryId: string,
  reason: string | undefined,
  confirmation?: ImpactConfirmation,
): Promise<Result> {
  try {
    const refused = await enquiriesRefusal();
    if (refused) return refused;
    const unconfirmed = await confirmImpact("enquiry-spam", enquiryId, confirmation);
    if (unconfirmed) return unconfirmed;
    const r = await markEnquirySpam(enquiryId, typeof reason === "string" ? reason : undefined);
    refresh(enquiryId);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}
