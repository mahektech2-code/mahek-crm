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
