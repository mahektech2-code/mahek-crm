import "server-only";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { levelInApp } from "@/lib/access-control";
import type { SectionKey } from "./types";

/* ---------------------------------------------------------------------------
 * Who may open which section, and act in it.
 *
 * Modules decide what a delegate SEES (PRD §5.4); the level on the Founder
 * app decides what they may DO. Admin is the founder: every action. A manager
 * acts inside the modules they hold. An associate reads — except on the two
 * desks associates have always run, price lists and WhatsApp.
 *
 * Every server action checks this on the server; the shell hides what a
 * person cannot open, and a hidden link is not a permission (PRD P11).
 * ------------------------------------------------------------------------- */

export const SECTION_MODULE: Record<SectionKey, string> = {
  company: "founder.overview",
  inbox: "founder.inbox",
  sales: "founder.crm",
  team: "founder.team",
  customers: "founder.customers",
  leads: "founder.leads",
  enquiries: "founder.enquiries",
  calling: "founder.calling",
  field: "founder.field",
  service: "founder.service",
  money: "founder.money",
  prices: "founder.price-lists",
  whatsapp: "founder.whatsapp",
  people: "founder.people",
  system: "founder.system",
};

export class NotAllowedHere extends Error {}

export async function founderAccess() {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes("founder")) throw new NotAllowedHere("The Founder Command Centre is not on your account.");
  const modules = await listUserModules(user.id, "founder");
  const keys = new Set(modules.map((m) => m.key));
  const allowed = (Object.keys(SECTION_MODULE) as SectionKey[]).filter((s) => keys.has(SECTION_MODULE[s]));
  const level = (await levelInApp(user, "founder")) ?? "associate";
  return { user, allowed, level };
}

export async function requireSection(section: SectionKey) {
  const a = await founderAccess();
  if (!a.allowed.includes(section)) {
    throw new NotAllowedHere("That section is not part of your access.");
  }
  return a;
}

/** Acting needs the section AND a level that may act in it. */
export async function requireActIn(section: SectionKey) {
  const a = await requireSection(section);
  if (a.level === "admin") return a;
  if (a.level === "manager") return a;
  if (section === "prices" || section === "whatsapp") return a;
  throw new NotAllowedHere("Your access to the Command Centre is read-only here. The founder or a manager-level delegate can do this.");
}

/**
 * WHICH SECTIONS OWN A NOTE'S TARGET.
 *
 * "Add a note" posted to an action that asked only whether the caller held the
 * Founder app — so a delegate given Money alone could write a note against an
 * employee, a complaint or a price list by sending a different `kind`, and an
 * associate the screen calls read-only could write against anything. A note is
 * an act in the section the record belongs to, so it is asked exactly as
 * `runAction` asks: the section's module, and a level that may act there.
 *
 * Several sections draw the same kind of record — a customer is on Customers
 * and on Money, a person on four screens — so holding ANY of them is enough. A
 * kind nobody listed here is refused rather than guessed at: a new note target
 * added without a line here fails shut, which is the direction to fail.
 */
export const NOTE_SECTIONS: Record<string, readonly SectionKey[]> = {
  customer: ["customers", "money"],
  user: ["team", "field", "calling", "people"],
  employee: ["people"],
  order: ["sales"],
  lead_funnel: ["sales"],
  bill: ["money"],
  payment_receipt: ["money"],
  aging_bucket: ["money"],
  price_list: ["prices"],
  price_request: ["prices"],
  enquiry: ["enquiries"],
  lead: ["leads"],
  lead_cohort: ["leads"],
  complaint: ["service"],
  whatsapp_readiness: ["whatsapp"],
  system_source: ["system"],
};

export async function requireNoteIn(kind: string) {
  const sections = NOTE_SECTIONS[kind] ?? [];
  let refusal: unknown = new NotAllowedHere("A note cannot be added to that record here.");
  for (const section of sections) {
    try {
      return await requireActIn(section);
    } catch (e) {
      refusal = e;
    }
  }
  throw refusal;
}
