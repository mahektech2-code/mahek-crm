"use server";

import { revalidatePath } from "next/cache";
import { fromThrown, type Result } from "@/lib/result";
import {
  linkWatiTemplate,
  setWhatsappService,
} from "@/lib/services/whatsapp-switch-service";

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
