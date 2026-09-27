import "server-only";
import type { ErpContext } from "./access";
import { erpHref, erpScreen } from "./registry";
import { loadCustomers, partyStatus } from "./screens/masters";
import type { Tone } from "./ui";

/* ---------------------------------------------------------------------------
 * The ERP dashboard (PRD §6, spec §13.6): what needs attention now, from data
 * the modules already hold. Every tile names the rows it counted, so opening
 * it lands on exactly those rows, and a tile for a screen the person does not
 * hold — or a money figure without its power — is never built at all.
 *
 * Each phase adds the sections for the screens it builds.
 * ------------------------------------------------------------------------- */

export type Tile = {
  l: string;
  v: string;
  sub?: string;
  tone?: Tone;
  href: string;
};

export type Section = { t: string; tiles: Tile[] };

/** A link to a screen, pre-filtered to the ids a tile counted. */
export function tileHref(screen: string, ids: string[] | null, label: string): string {
  const s = erpScreen(screen);
  const base = s ? erpHref(s) : "/erp";
  if (!ids) return base;
  return `${base}?f=${encodeURIComponent(ids.join(","))}&fl=${encodeURIComponent(label)}`;
}

export async function dashboardSections(ctx: ErpContext, godownName: string | null): Promise<Section[]> {
  void godownName;
  const out: Section[] = [];

  if (ctx.screens.has("customers")) {
    const tiles: Tile[] = [];
    if (ctx.powers.has("customerStatus")) {
      const pending = (await loadCustomers()).filter((c) => partyStatus(c) === "Pending");
      tiles.push({
        l: "Pending activation",
        v: String(pending.length),
        sub: "an admin activates them",
        tone: pending.length ? "warn" : undefined,
        href: tileHref("customers", pending.map((c) => c.id), "Pending"),
      });
    }
    if (tiles.length) out.push({ t: "Customers", tiles });
  }

  return out;
}
