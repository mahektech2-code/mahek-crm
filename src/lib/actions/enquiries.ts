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
  type CustomerMatch,
} from "@/lib/services/enquiry-service";
import { fromThrown, type Result } from "@/lib/result";
import type { EnquiryPriority, EnquiryStage } from "@/lib/enquiry-labels";

/**
 * Thin over the service, which owns the access check. Every action here is
 * verified there, not merely hidden here — a disabled control is a courtesy,
 * not a permission.
 */
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
  try {
    const r = await changeStage(enquiryId, stage);
    refresh(enquiryId);
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function changePriorityAction(enquiryId: string, priority: EnquiryPriority): Promise<Result> {
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
  type: "call_back" | "payment_promise" | "order_confirmation" | "send_information" | "check_stock" | "other";
  assignedUserId: string;
}): Promise<Result> {
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
