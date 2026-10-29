import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { publicLinkOrigin } from "@/lib/public-links";

/* ---------------------------------------------------------------------------
 * WHAT EVERY ERP MESSAGE TO A CUSTOMER SHARES: whether Wati can carry it, the
 * address a link is built against, and who must never be messaged as if they
 * were the customer. Logistics and order tracking both send through here, so
 * the two cannot disagree about when a message goes by hand.
 * ------------------------------------------------------------------------- */

export type WatiRoute = { ok: true; name: string; params: string[] } | { ok: false; why: string };

/** Whether a named template can carry a message now, and the parameters it asks for. */
export async function watiRoute(templateName: string, what = "logistics"): Promise<WatiRoute> {
  const name = (templateName ?? "").trim();
  if (!name) return { ok: false, why: `No ${what} template is named in ERP settings, so this goes by hand.` };
  const { whatsappServiceState } = await import("@/lib/services/whatsapp-switch-service");
  if (!(await whatsappServiceState()).active) return { ok: false, why: "WhatsApp through Wati is switched off on the Founder Dashboard." };
  const { listWatiTemplates, isApproved, watiConfig } = await import("@/lib/wati");
  if (!(await watiConfig())) return { ok: false, why: "No Wati key is configured." };
  const list = await listWatiTemplates();
  if (!list.ok) return { ok: false, why: `Wati could not be asked for its templates: ${list.error}` };
  const t = list.templates.find((x) => x.name === name);
  if (!t) return { ok: false, why: `There is no Wati template called ${name}.` };
  if (!isApproved(t)) return { ok: false, why: `The Wati template ${name} is not approved yet.` };
  return { ok: true, name, params: t.params };
}

/** The address a customer's link is built against. */
export async function messageOrigin(): Promise<string | null> {
  /* A link sent outside goes out on the public host where one is set — never the staff workspace's address. */
  const pub = publicLinkOrigin();
  if (pub) return pub;
  try {
    const { appOrigin } = await import("@/lib/password-reset");
    return await appOrigin();
  } catch {
    return null;
  }
}

/** The last ten digits of every number on a MahekOne account — a customer row carrying one is not the customer. */
export async function staffNumbers(): Promise<Set<string>> {
  const rows = (await db.execute(sql`select right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) as p from users where coalesce(phone, '') <> ''`)) as unknown as { p: string }[];
  return new Set(rows.map((x) => x.p));
}

/** Why this customer is not messaged, or null. Never silently dropped: the caller records the reason. */
export function skipReason(c: { name: string; doNotContact: boolean | null; whatsappDnd: boolean | null; deletedAt: Date | null }, raw: string | null, phone: string | null, staff: Set<string>): string | null {
  if (c.doNotContact) return `${c.name} is marked do not contact.`;
  if (c.whatsappDnd) return `${c.name} is on WhatsApp DND.`;
  if (c.deletedAt) return `${c.name} is in the trash.`;
  if (!phone) return `${raw || "No number"} is not a mobile WhatsApp can reach. Fix it on the customer record.`;
  if (staff.has(phone.slice(-10))) return "That number belongs to somebody who works at Mahek, not to the customer.";
  return null;
}
