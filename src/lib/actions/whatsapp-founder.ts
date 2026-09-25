"use server";

import { revalidatePath } from "next/cache";
import { fromThrown, ok, type Result } from "@/lib/result";
import {
  linkWatiTemplate,
  requireFounderDesk,
  setWhatsappService,
} from "@/lib/services/whatsapp-switch-service";
import {
  findCustomersByName,
  previewMessage,
  sendTestMessage,
  type MessagePreview,
} from "@/lib/services/whatsapp-service";
import {
  deleteRule,
  previewAutomation,
  runAutomation,
  saveAutomationSettings,
  saveRule,
  setRuleStatus,
  type RuleInput,
  type RunSummary,
} from "@/lib/services/whatsapp-automation-service";
import type { RuleStatus, WindowSettings } from "@/lib/whatsapp-rules";

/* ---------------------------------------------------------------------------
 * The Founder Dashboard's WhatsApp screen — its two writes.
 *
 * Both are checked in the service (`requireFounderDesk`), not here and not by
 * hiding the control: a server action is a URL, and the switch that decides
 * whether messages leave the building must not be reachable by posting to one.
 * ------------------------------------------------------------------------- */

function refresh() {
  revalidatePath("/founder/whatsapp");
  revalidatePath("/crm/whatsapp");
  revalidatePath("/crm/payments");
}

export async function setWhatsappServiceAction(
  active: boolean,
  note: string,
): Promise<Result> {
  try {
    const r = await setWhatsappService({ active, note });
    refresh();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function linkWatiTemplateAction(
  templateId: string,
  watiTemplateName: string | null,
): Promise<Result> {
  try {
    const r = await linkWatiTemplate(templateId, watiTemplateName);
    refresh();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

/** Exactly what one customer would receive from one template, or why not. */
export async function founderPreviewAction(
  customerId: string,
  templateId: string,
): Promise<Result<MessagePreview>> {
  try {
    await requireFounderDesk();
    return ok(await previewMessage(customerId, templateId, "personal", { skipScope: true }));
  } catch (e) {
    return fromThrown(e);
  }
}

/** The real template, one real customer's facts, sent to the founder's own phone. */
export async function sendTestAction(
  customerId: string,
  templateId: string,
  phone: string,
): Promise<Result<{ body: string }>> {
  try {
    const ctx = await requireFounderDesk();
    return await sendTestMessage({ customerId, templateId, phone, userId: ctx.user.id });
  } catch (e) {
    return fromThrown(e);
  }
}

export async function findCustomersAction(
  q: string,
): Promise<Result<Array<{ id: string; name: string; city: string | null }>>> {
  try {
    await requireFounderDesk();
    return ok(await findCustomersByName(q));
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------- automation */


function refreshAutomation() {
  revalidatePath("/founder/whatsapp/automation");
}

export async function saveWindowAction(w: WindowSettings): Promise<Result> {
  try {
    const r = await saveAutomationSettings(w);
    refreshAutomation();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function saveRuleAction(input: RuleInput): Promise<Result<{ id: string }>> {
  try {
    const r = await saveRule(input);
    refreshAutomation();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function setRuleStatusAction(id: string, status: RuleStatus): Promise<Result> {
  try {
    const r = await setRuleStatus(id, status);
    refreshAutomation();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function deleteRuleAction(id: string): Promise<Result> {
  try {
    const r = await deleteRule(id);
    refreshAutomation();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

/** Works out every enabled rule (or the ones named) right now. Never sends. */
export async function previewAutomationAction(ruleIds?: string[]): Promise<Result<RunSummary>> {
  try {
    const r = await previewAutomation(ruleIds);
    refreshAutomation();
    return ok(r, `${r.wouldSend} would be sent`);
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * The hourly pass, now, on the founder's word — with every gate the schedule
 * has: the window, the service switch, Live rules only, the daily limit.
 */
export async function runLiveNowAction(): Promise<Result<RunSummary>> {
  try {
    await requireFounderDesk();
    const r = await runAutomation({ source: "schedule" });
    refreshAutomation();
    return ok(r, r.runId ? `${r.sent} sent · ${r.wouldSend} previewed` : r.note);
  } catch (e) {
    return fromThrown(e);
  }
}
