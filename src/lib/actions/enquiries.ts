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
  type CustomerMatch,
  type EnquiryForLead,
} from "@/lib/services/enquiry-service";
import { requireUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { canFor } from "@/lib/access-control";
import { DESK_MODULE, deskHolders, type DeskPerson } from "@/lib/services/lead-desk-assignment-service";
import { err, fromThrown, type Result } from "@/lib/result";
import {
  ENQUIRY_PRIORITIES,
  ENQUIRY_REMINDER_TYPES,
  ENQUIRY_STAGES,
  type EnquiryPriority,
  type EnquiryReminderType,
  type EnquiryStage,
} from "@/lib/enquiry-labels";

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
    revalidatePath("/enquiries/list");
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

export async function unlinkOrderAction(enquiryId: string, orderId: string): Promise<Result> {
  try {
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
